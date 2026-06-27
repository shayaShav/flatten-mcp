import { createReadStream, constants as FS_CONSTANTS } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import type { SessionMessage, ContentBlock } from './types.js';
// Shared core: the marker protocol, classification, and token estimation live in
// core.ts as the single source of truth. This file is the Claude Code disk
// adapter over that core. core.ts has no side effects (it never boots the
// server), so importing it here is safe.
import {
    MARKER_PREFIX,
    MARKER_ID_RE,
    TEXT_BYTES_PER_TOKEN,
    classifyContent,
    valueByteSize,
    estimateContentTokens,
    toCountBlocks,
    countTokensExact,
    buildMarker,
    type FlattenKind,
} from './core.js';

export type { FlattenKind } from './core.js';
// Where a flattened payload lived on the line:
//   'content'        -> a tool_result block inside message.content (the API message)
//   'toolUseResult'  -> the top-level toolUseResult mirror Claude Code keeps per line
export type FlattenSlot = 'content' | 'toolUseResult';

export interface FlattenEntry {
    id: string;            // unique key: tool_use_id, or "<tool_use_id>#tur" for the mirror
    slot: FlattenSlot;
    name: string;
    input: Record<string, unknown>;
    // Full ORIGINAL value, lossless: a string, a content-block array (incl. base64
    // image blocks), or the raw toolUseResult object. Storing it verbatim is what
    // makes unflatten byte-faithful, even for mixed text+image results.
    content: unknown;
    size: number;
    lineCount: number;
    timestamp: string;
    kind: FlattenKind;
}

export interface FlattenResult {
    sessionId: string;
    flattenedCount: number;
    bytesSaved: number;          // DISK bytes removed from the .jsonl (parse-speed metric)
    originalSize: number;
    newSize: number;
    // CONTEXT-token metrics — the number that actually matters for --resume/compaction.
    // Only message.content removals affect context; the toolUseResult mirror is disk-only.
    contextTokensTotal: number | null;  // real context size from the last turn's API usage
    contextTokensSaved: number;         // tokens removed from the model's context
    contextTokensExact: boolean;        // true if counted via count_tokens, false if estimated
    imageBlocksFlattened: number;       // images removed (huge disk win, small token win)
    sidecarPath: string;
    backupPath: string;
    skipped?: string;
    entries: Array<{ id: string; name: string; size: number; kind: FlattenKind; slot: FlattenSlot }>;
}

export interface UnflattenResult {
    sessionId: string;
    restoredCount: number;
    notFound: string[];
    originalSize: number;
    newSize: number;
    backupPath: string;
    skipped?: string;
}

export interface RetrieveResult {
    tool_use_id: string;
    tool_name: string;
    original_size: number;
    line_count: number;
    kind: FlattenKind;
    slot: FlattenSlot;
    content: unknown;
}

/** Suffix distinguishing a flattened toolUseResult entry from its content sibling. */
const TUR_ID_SUFFIX = '#tur';

/**
 * A session file modified more recently than this is assumed to be live (Claude
 * Code is still appending to it). Rewriting it in place risks racing concurrent
 * writes, so we refuse unless force=true. Read-only dry runs are always allowed.
 */
const ACTIVE_SESSION_THRESHOLD_MS = 10_000;

/**
 * Scan assistant messages for tool_use blocks and build a map from
 * tool_use_id to { name, input }. This is needed because tool_result
 * blocks in user messages only carry tool_use_id, not the tool name.
 */
export function buildToolNameMap(
    lines: string[]
): Map<string, { name: string; input: Record<string, unknown> }> {
    const map = new Map<string, { name: string; input: Record<string, unknown> }>();

    for (const line of lines) {
        let parsed: SessionMessage;
        try {
            parsed = JSON.parse(line) as SessionMessage;
        } catch {
            continue;
        }

        if (parsed.type !== 'assistant') continue;

        const content = parsed.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
            // In raw JSONL, tool_use blocks carry "id" (not "tool_use_id").
            if (block.type === 'tool_use' && block.id && block.name) {
                map.set(block.id, {
                    name: block.name,
                    input: block.input ?? {},
                });
            }
        }
    }

    return map;
}

/** Detect an image-bearing toolUseResult (its mirror of a screenshot). */
function toolUseResultIsImage(tur: unknown): boolean {
    if (!tur || typeof tur !== 'object') return false;
    const o = tur as Record<string, unknown>;
    if (o.type === 'image') return true;
    const file = o.file as Record<string, unknown> | undefined;
    if (file && typeof file === 'object') {
        if (typeof file.base64 === 'string') return true;
        if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
    }
    return false;
}

// ─── Context-token measurement ──────────────────────────────────────
// Why this exists: the disk byte-savings reported by flatten is a poor proxy
// for tokens removed from the model's context. ~half of a session file is
// metadata/mirror the model never sees, and images cost ~38 B/token vs ~3.5
// B/token for text — so bytes and tokens decouple. These helpers report the
// CONTEXT-token number instead, exact when an API key is present. The estimator,
// the count_tokens helpers (toCountBlocks/countTokensExact), and the constants
// all live in core.ts now; only usageContextTokens below is disk-specific (it
// reads the per-turn API usage that exists only in the session JSONL).

/** Total tokens of an assistant turn's API usage = the real context size at that point. */
function usageContextTokens(usage: unknown): number {
    if (!usage || typeof usage !== 'object') return 0;
    const u = usage as Record<string, number>;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

/**
 * Write extracted flatten entries to the sidecar JSONL file. Appends if the
 * file already exists.
 */
export async function writeSidecar(
    sidecarPath: string,
    entries: FlattenEntry[]
): Promise<void> {
    if (entries.length === 0) return;
    const lines = entries.map(entry => JSON.stringify(entry));
    await fs.appendFile(sidecarPath, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Atomic write: stage the new bytes in a sibling temp file, then rename(2) over
 * the target. rename is atomic on the same filesystem, so a crash mid-write can
 * never leave a half-written (truncated/corrupt) session JSONL — the
 * irreplaceable file is either fully the old version or fully the new one.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
}

/**
 * Collect the ids already present in a sidecar. Makes flatten idempotent at the
 * sidecar level: if a previous run crashed AFTER appending entries but BEFORE
 * rewriting the main file, the next run must not append the same originals
 * again. Returns an empty set if the sidecar does not exist yet.
 */
async function readSidecarIds(sidecarPath: string): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
        const rl = readline.createInterface({
            input: createReadStream(sidecarPath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as FlattenEntry;
                if (entry.id) ids.add(entry.id);
            } catch {
                continue;
            }
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return ids;
}

/**
 * Back up the original JSONL ONCE. If a backup already exists it is preserved —
 * never overwritten — so re-running flatten can't clobber the true original
 * with an already-flattened copy.
 */
export async function backupOnce(filePath: string, backupPath: string): Promise<void> {
    try {
        await fs.copyFile(filePath, backupPath, FS_CONSTANTS.COPYFILE_EXCL);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw err;
    }
}

function emptyResult(
    sessionId: string,
    originalSize: number,
    sidecarPath: string,
    backupPath: string,
    skipped?: string,
    contextTokensTotal: number | null = null
): FlattenResult {
    return {
        sessionId,
        flattenedCount: 0,
        bytesSaved: 0,
        originalSize,
        newSize: originalSize,
        contextTokensTotal,
        contextTokensSaved: 0,
        contextTokensExact: false,
        imageBlocksFlattened: 0,
        sidecarPath,
        backupPath,
        skipped,
        entries: [],
    };
}

/**
 * Main flatten entry point. Reads the session JSONL and extracts bulky payloads
 * larger than minSize to a lossless sidecar, replacing them with lightweight
 * markers. Two payload sources are handled:
 *   1. tool_result blocks in message.content — text AND base64 image blocks.
 *   2. the top-level toolUseResult mirror Claude Code stores per result line,
 *      which duplicates (1) on disk. Controlled by flattenToolUseResult.
 */
export async function flattenSession(
    filePath: string,
    minSize: number,
    dryRun: boolean,
    force = false,
    flattenToolUseResult = true
): Promise<FlattenResult> {
    const sessionDir = filePath.replace(/\/[^/]+$/, '');
    const sessionFileName = filePath.replace(/^.*\//, '').replace(/\.jsonl$/, '');
    const sidecarPath = `${sessionDir}/${sessionFileName}.flat.jsonl`;
    const backupPath = `${filePath}.bak`;

    const originalContent = await fs.readFile(filePath, 'utf-8');
    const originalSize = Buffer.byteLength(originalContent, 'utf-8');
    const lines = originalContent.trimEnd().split('\n');

    // Extract sessionId from the first message that carries it.
    let sessionId = '';
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as SessionMessage;
            if (parsed.sessionId) {
                sessionId = parsed.sessionId;
                break;
            }
        } catch {
            continue;
        }
    }

    // Live-session guard: refuse to rewrite a file that is likely being written
    // to right now (e.g. the caller's own current session). Dry runs are safe.
    if (!dryRun && !force) {
        const stat = await fs.stat(filePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < ACTIVE_SESSION_THRESHOLD_MS) {
            return emptyResult(
                sessionId,
                originalSize,
                sidecarPath,
                backupPath,
                `Session was modified ${Math.round(ageMs / 1000)}s ago and may be active (Claude Code still appending). ` +
                `Rewriting it could race concurrent writes. Re-run with force=true once the session is idle, or flatten a different session.`
            );
        }
    }

    const toolNameMap = buildToolNameMap(lines);
    const sidecarEntries: FlattenEntry[] = [];
    const modifiedLines: string[] = [];

    // Context-token accumulators. Only message.content removals (slot 'content')
    // count toward context; the toolUseResult mirror is disk-only.
    let contextTokensTotal: number | null = null;
    let estContextTokensSaved = 0;
    let imageBlocksFlattened = 0;
    const removedContentValues: unknown[] = [];
    const removedMarkers: string[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        let parsed: (SessionMessage & { toolUseResult?: unknown; message?: { content: unknown; usage?: unknown } });
        try {
            parsed = JSON.parse(line);
        } catch {
            modifiedLines.push(line);
            continue;
        }

        // Track the real context size from the most recent turn's API usage.
        const turnTokens = usageContextTokens((parsed as { message?: { usage?: unknown } }).message?.usage);
        if (turnTokens > 0) contextTokensTotal = turnTokens;

        if (parsed.type !== 'user' || !Array.isArray(parsed.message?.content)) {
            modifiedLines.push(line);
            continue;
        }

        let modified = false;
        const timestamp = parsed.timestamp ?? new Date().toISOString();
        const contentBlocks = parsed.message!.content as ContentBlock[];
        let lineToolUseId: string | null = null;

        // (1) message.content tool_result blocks (text + images)
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];
            if (block.type !== 'tool_result') continue;
            if (!lineToolUseId && block.tool_use_id) lineToolUseId = block.tool_use_id;

            const original = block.content;
            if (original === undefined || original === null) continue;
            if (typeof original === 'string' && original.startsWith(MARKER_PREFIX)) continue; // idempotent

            const size = valueByteSize(original);
            if (size <= minSize) continue;

            const { kind, text } = classifyContent(original);
            if (kind === 'none') continue;

            const lineCount = text ? text.split('\n').length : 1;
            const toolUseId = block.tool_use_id ?? 'unknown';
            const toolInfo = toolNameMap.get(toolUseId);
            const toolName = toolInfo?.name ?? 'unknown';
            const toolInput = toolInfo?.input ?? {};

            const marker = buildMarker({ id: toolUseId, name: toolName, input: toolInput, kind, size, lineCount, sessionId });
            sidecarEntries.push({
                id: toolUseId, slot: 'content', name: toolName, input: toolInput,
                content: original, size, lineCount, timestamp, kind,
            });
            contentBlocks[i] = { ...block, content: marker };
            modified = true;

            // Context-token bookkeeping: this is a slot 'content' removal, so it
            // reduces what the model sees. Net = tokens(original) − tokens(marker).
            const est = estimateContentTokens(original);
            const markerTokens = Math.ceil(Buffer.byteLength(marker, 'utf-8') / TEXT_BYTES_PER_TOKEN);
            estContextTokensSaved += Math.max(0, est.tokens - markerTokens);
            imageBlocksFlattened += est.images;
            removedContentValues.push(original);
            removedMarkers.push(marker);
        }

        // (2) top-level toolUseResult mirror (duplicates the result on disk)
        if (flattenToolUseResult && parsed.toolUseResult != null) {
            const tur = parsed.toolUseResult;
            const alreadyFlat = typeof tur === 'string' && tur.startsWith(MARKER_PREFIX);
            if (!alreadyFlat) {
                const size = valueByteSize(tur);
                if (size > minSize) {
                    const base = lineToolUseId ?? `line${lineIndex}`;
                    const id = `${base}${TUR_ID_SUFFIX}`;
                    const kind: FlattenKind = toolUseResultIsImage(tur) ? 'image' : 'text';
                    const toolInfo = lineToolUseId ? toolNameMap.get(lineToolUseId) : undefined;
                    const toolName = toolInfo?.name ?? 'unknown';
                    const toolInput = toolInfo?.input ?? {};
                    const lineCount = typeof tur === 'string' ? tur.split('\n').length : 1;

                    const marker = buildMarker({ id, name: toolName, input: toolInput, kind, size, lineCount, sessionId });
                    sidecarEntries.push({
                        id, slot: 'toolUseResult', name: toolName, input: toolInput,
                        content: tur, size, lineCount, timestamp, kind,
                    });
                    parsed.toolUseResult = marker;
                    modified = true;
                }
            }
        }

        modifiedLines.push(modified ? JSON.stringify(parsed) : line);
    }

    if (sidecarEntries.length === 0) {
        return emptyResult(sessionId, originalSize, sidecarPath, backupPath, undefined, contextTokensTotal);
    }

    const newContent = modifiedLines.join('\n') + '\n';
    const newSize = Buffer.byteLength(newContent, 'utf-8');
    const bytesSaved = originalSize - newSize;

    // Upgrade the local estimate to an exact count_tokens result when an API key
    // is configured. Falls back silently to the estimate on any failure.
    let contextTokensSaved = estContextTokensSaved;
    let contextTokensExact = false;
    if (process.env.ANTHROPIC_API_KEY && removedContentValues.length > 0) {
        const removedExact = await countTokensExact(toCountBlocks(removedContentValues));
        const markerExact = await countTokensExact([{ type: 'text', text: removedMarkers.join('\n') }]);
        if (removedExact != null) {
            contextTokensSaved = Math.max(0, removedExact - (markerExact ?? 0));
            contextTokensExact = true;
        }
    }

    if (!dryRun) {
        // Order matters for crash-safety: persist originals to the sidecar BEFORE
        // removing them from the main file, and dedupe so a re-run after a crash
        // can't append the same originals twice.
        const existingIds = await readSidecarIds(sidecarPath);
        const newEntries = sidecarEntries.filter(e => !existingIds.has(e.id));
        await writeSidecar(sidecarPath, newEntries);
        await backupOnce(filePath, backupPath);
        await writeFileAtomic(filePath, newContent);
    }

    return {
        sessionId,
        flattenedCount: sidecarEntries.length,
        bytesSaved,
        originalSize,
        newSize,
        contextTokensTotal,
        contextTokensSaved,
        contextTokensExact,
        imageBlocksFlattened,
        sidecarPath,
        backupPath,
        entries: sidecarEntries.map(e => ({ id: e.id, name: e.name, size: e.size, kind: e.kind, slot: e.slot })),
    };
}

/**
 * Restore a flattened session in place: re-inline every flattened tool_result
 * AND toolUseResult mirror from its sidecar. The reverse of flattenSession.
 * Snapshots the flattened file to <file>.preunflatten.bak before writing.
 */
export async function unflattenSession(
    filePath: string,
    sidecarPath: string
): Promise<UnflattenResult> {
    const backupPath = `${filePath}.preunflatten.bak`;

    // Build id -> original-value map from the sidecar (last entry wins).
    const valueById = new Map<string, unknown>();
    try {
        const rl = readline.createInterface({
            input: createReadStream(sidecarPath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as FlattenEntry;
                valueById.set(entry.id, entry.content);
            } catch {
                continue;
            }
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                sessionId: '', restoredCount: 0, notFound: [], originalSize: 0, newSize: 0,
                backupPath, skipped: `No sidecar found at ${sidecarPath}. Nothing to restore.`,
            };
        }
        throw err;
    }

    const originalContent = await fs.readFile(filePath, 'utf-8');
    const originalSize = Buffer.byteLength(originalContent, 'utf-8');
    const lines = originalContent.trimEnd().split('\n');

    let sessionId = '';
    let restoredCount = 0;
    const notFound: string[] = [];
    const modifiedLines: string[] = [];

    for (const line of lines) {
        let parsed: (SessionMessage & { toolUseResult?: unknown });
        try {
            parsed = JSON.parse(line);
        } catch {
            modifiedLines.push(line);
            continue;
        }

        if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;

        if (parsed.type !== 'user' || !Array.isArray(parsed.message?.content)) {
            modifiedLines.push(line);
            continue;
        }

        let modified = false;
        const contentBlocks = parsed.message!.content as ContentBlock[];

        // (1) restore message.content tool_result markers
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];
            if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
            const match = block.content.match(MARKER_ID_RE);
            if (!match) continue;
            const id = match[1];
            if (valueById.has(id)) {
                contentBlocks[i] = { ...block, content: valueById.get(id) as ContentBlock['content'] };
                restoredCount++;
                modified = true;
            } else {
                notFound.push(id);
            }
        }

        // (2) restore the toolUseResult mirror marker
        if (typeof parsed.toolUseResult === 'string') {
            const match = parsed.toolUseResult.match(MARKER_ID_RE);
            if (match) {
                const id = match[1];
                if (valueById.has(id)) {
                    parsed.toolUseResult = valueById.get(id);
                    restoredCount++;
                    modified = true;
                } else {
                    notFound.push(id);
                }
            }
        }

        modifiedLines.push(modified ? JSON.stringify(parsed) : line);
    }

    const newContent = modifiedLines.join('\n') + '\n';
    const newSize = Buffer.byteLength(newContent, 'utf-8');

    if (restoredCount > 0) {
        await fs.copyFile(filePath, backupPath);
        await writeFileAtomic(filePath, newContent);
    }

    return { sessionId, restoredCount, notFound, originalSize, newSize, backupPath };
}

/**
 * Retrieve an original payload from a sidecar file by id. Streams the sidecar
 * JSONL line by line to avoid loading the entire file. Returns the raw value
 * (string, content-block array incl. images, or toolUseResult object) so the
 * caller can render text and images appropriately.
 */
export async function retrieveFlattened(
    sidecarPath: string,
    toolUseId: string
): Promise<RetrieveResult> {
    const rl = readline.createInterface({
        input: createReadStream(sidecarPath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });

    const availableIds: string[] = [];
    // Last-wins, consistent with unflattenSession (which overwrites by id). If a
    // crashed run left a duplicate id, both restore and retrieve resolve to the
    // same — the most recent — entry.
    let found: RetrieveResult | null = null;

    for await (const line of rl) {
        if (!line.trim()) continue;

        let entry: FlattenEntry;
        try {
            entry = JSON.parse(line) as FlattenEntry;
        } catch {
            continue;
        }

        availableIds.push(entry.id);

        if (entry.id === toolUseId) {
            found = {
                tool_use_id: entry.id,
                tool_name: entry.name,
                original_size: entry.size,
                line_count: entry.lineCount,
                kind: entry.kind ?? 'text',
                slot: entry.slot ?? 'content',
                content: entry.content,
            };
        }
    }

    if (found) return found;

    // Cap the id list so a large sidecar doesn't produce a multi-KB error string.
    const shown = availableIds.slice(0, 20).join(', ');
    const more = availableIds.length > 20 ? ` (+${availableIds.length - 20} more)` : '';
    throw new Error(`id "${toolUseId}" not found in sidecar. Available IDs: ${shown}${more}`);
}
