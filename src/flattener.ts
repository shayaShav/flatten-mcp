import { createReadStream } from 'fs';
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

// ─── Artifact model ─────────────────────────────────────────────────
// Flatten keeps exactly ONE side artifact per session: a backup at
// `<session>.jsonl.bak` that always holds the COMPLETE session, fully inlined —
// "the session as if you'd never flattened". The live `<session>.jsonl` carries
// the lightweight markers. The two are duals, maintained together on every
// flatten:
//   • backup = unflatten(live)   (the originals, complete)
//   • live   = flatten(backup)   (the markers)
// retrieve reads an original straight out of the backup; unflatten re-inlines the
// live file from the backup and then DELETES the backup, so a fully restored
// session leaves zero artifacts behind. There is no sidecar and no
// pre-unflatten snapshot — the model is self-cleaning by construction.

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
    backupPath: string;                 // the single self-syncing backup (complete inlined session)
    entries: Array<{ id: string; name: string; size: number; kind: FlattenKind; slot: FlattenSlot }>;
}

export interface UnflattenResult {
    sessionId: string;
    restoredCount: number;
    notFound: string[];
    originalSize: number;
    newSize: number;
    backupPath: string;          // the backup that was restored from (and removed on full restore)
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
 * Explicit opt-in gate for the exact-count network call (issue #12). The disk
 * path (MCP server + session CLI) contacts count_tokens only when BOTH
 * FLATTEN_COUNT_EXACT is affirmative AND ANTHROPIC_API_KEY is set — key presence
 * alone no longer triggers the request, because many environments export the key
 * globally and the trigger must be user intent, not key presence. The library's
 * async *Exact variants keep their explicit countExact parameter instead
 * (core.ts) and are not affected by this variable.
 */
function exactCountOptIn(): boolean {
    const v = (process.env.FLATTEN_COUNT_EXACT ?? '').trim().toLowerCase();
    return (v === '1' || v === 'true' || v === 'yes' || v === 'on') && Boolean(process.env.ANTHROPIC_API_KEY);
}

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
 * Atomic write: stage the new bytes in a sibling temp file, then rename(2) over
 * the target. rename is atomic on the same filesystem, so a crash mid-write can
 * never leave a half-written (truncated/corrupt) file — the target is either
 * fully the old version or fully the new one.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
}

/**
 * Harvest every original payload from a session's lines into an id -> value map,
 * keyed exactly as the markers reference them: content tool_results by
 * tool_use_id, and toolUseResult mirrors by "<tool_use_id>#tur". Used to read the
 * complete originals out of the backup. Already-flattened values (markers) are
 * skipped — the backup is expected to be fully inlined, but a stray marker (e.g.
 * an unrecoverable prior state) is never mistaken for an original.
 */
function harvestOriginals(lines: string[]): Map<string, unknown> {
    const map = new Map<string, unknown>();

    for (let idx = 0; idx < lines.length; idx++) {
        let parsed: (SessionMessage & { toolUseResult?: unknown });
        try {
            parsed = JSON.parse(lines[idx]);
        } catch {
            continue;
        }

        let lineToolUseId: string | null = null;

        if (parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
            for (const block of parsed.message!.content as ContentBlock[]) {
                if (block.type !== 'tool_result') continue;
                if (!lineToolUseId && block.tool_use_id) lineToolUseId = block.tool_use_id;
                const c = block.content;
                if (
                    block.tool_use_id && c !== undefined && c !== null &&
                    !(typeof c === 'string' && c.startsWith(MARKER_PREFIX))
                ) {
                    map.set(block.tool_use_id, c);
                }
            }
        }

        if (parsed.toolUseResult != null) {
            const tur = parsed.toolUseResult;
            if (!(typeof tur === 'string' && tur.startsWith(MARKER_PREFIX))) {
                // Mirror key mirrors flatten's id construction. With a tool_use_id
                // present (the normal case) the key is position-independent and
                // aligns regardless of where the line sits; the line-index fallback
                // is reserved for the rare mirror-without-tool_result shape.
                const base = lineToolUseId ?? `line${idx}`;
                map.set(`${base}${TUR_ID_SUFFIX}`, tur);
            }
        }
    }

    return map;
}

/**
 * Re-inline a session's lines against an id -> original map: every
 * `[FLATTENED id=…]` marker whose id is present is replaced by its original
 * value, in both the message.content and toolUseResult slots. Lines with no
 * resolvable marker pass through verbatim. This is the shared workhorse behind
 * both "rebuild the complete backup" (flatten) and "restore the live file"
 * (unflatten). The input strings are never mutated; a new array is returned.
 */
function inlineLines(lines: string[], originals: Map<string, unknown>): string[] {
    const out: string[] = [];

    for (const line of lines) {
        let parsed: (SessionMessage & { toolUseResult?: unknown });
        try {
            parsed = JSON.parse(line);
        } catch {
            out.push(line);
            continue;
        }

        let modified = false;

        if (parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
            const blocks = parsed.message!.content as ContentBlock[];
            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
                const match = block.content.match(MARKER_ID_RE);
                if (!match) continue;
                const id = match[1];
                if (originals.has(id)) {
                    blocks[i] = { ...block, content: originals.get(id) as ContentBlock['content'] };
                    modified = true;
                }
            }
        }

        if (typeof parsed.toolUseResult === 'string') {
            const match = parsed.toolUseResult.match(MARKER_ID_RE);
            if (match && originals.has(match[1])) {
                parsed.toolUseResult = originals.get(match[1]);
                modified = true;
            }
        }

        out.push(modified ? JSON.stringify(parsed) : line);
    }

    return out;
}

function emptyResult(
    sessionId: string,
    originalSize: number,
    backupPath: string,
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
        backupPath,
        entries: [],
    };
}

/**
 * Main flatten entry point. Reads the session JSONL and extracts bulky payloads
 * larger than minSize, replacing them with lightweight markers. Two payload
 * sources are handled:
 *   1. tool_result blocks in message.content — text AND base64 image blocks.
 *   2. the top-level toolUseResult mirror Claude Code stores per result line,
 *      which duplicates (1) on disk. Controlled by flattenToolUseResult.
 *
 * Extraction is idempotent at the line level (lines already carrying a marker
 * are skipped), so re-running on a live session only touches newly-arrived bulk
 * and the reported metrics are per-operation. The originals are persisted to the
 * single backup, which is rebuilt each run as the COMPLETE inlined session
 * (markers already in the live file are resolved against the prior backup; bulk
 * added since the last flatten is still inline and passes through).
 */
export async function flattenSession(
    filePath: string,
    minSize: number,
    dryRun: boolean,
    flattenToolUseResult = true
): Promise<FlattenResult> {
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

    const toolNameMap = buildToolNameMap(lines);
    const extracted: FlattenEntry[] = [];
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
            extracted.push({
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
                    extracted.push({
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

    if (extracted.length === 0) {
        return emptyResult(sessionId, originalSize, backupPath, contextTokensTotal);
    }

    const newContent = modifiedLines.join('\n') + '\n';
    const newSize = Buffer.byteLength(newContent, 'utf-8');
    const bytesSaved = originalSize - newSize;

    // Upgrade the local estimate to an exact count_tokens result when the user
    // explicitly opted in (FLATTEN_COUNT_EXACT=1 + ANTHROPIC_API_KEY, see
    // exactCountOptIn). Falls back silently to the estimate on any failure.
    let contextTokensSaved = estContextTokensSaved;
    let contextTokensExact = false;
    if (exactCountOptIn() && removedContentValues.length > 0) {
        const removedExact = await countTokensExact(toCountBlocks(removedContentValues));
        const markerExact = await countTokensExact([{ type: 'text', text: removedMarkers.join('\n') }]);
        if (removedExact != null) {
            contextTokensSaved = Math.max(0, removedExact - (markerExact ?? 0));
            contextTokensExact = true;
        }
    }

    if (!dryRun) {
        // Rebuild the backup as the COMPLETE inlined session: resolve the markers
        // already in the live file against the prior backup (bulk added since the
        // last flatten is still inline in `lines` and passes through). Empty map
        // on the first flatten, so the backup is then the verbatim pristine
        // original.
        let priorOriginals = new Map<string, unknown>();
        try {
            const backupContent = await fs.readFile(backupPath, 'utf-8');
            priorOriginals = harvestOriginals(backupContent.trimEnd().split('\n'));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        const completeContent = inlineLines(lines, priorOriginals).join('\n') + '\n';

        // Order matters for crash-safety: persist the complete originals to the
        // backup BEFORE removing the bulk from the live file. A crash between the
        // two leaves the live file's markers fully resolvable against the backup.
        await writeFileAtomic(backupPath, completeContent);
        await writeFileAtomic(filePath, newContent);
    }

    return {
        sessionId,
        flattenedCount: extracted.length,
        bytesSaved,
        originalSize,
        newSize,
        contextTokensTotal,
        contextTokensSaved,
        contextTokensExact,
        imageBlocksFlattened,
        backupPath,
        entries: extracted.map(e => ({ id: e.id, name: e.name, size: e.size, kind: e.kind, slot: e.slot })),
    };
}

/**
 * Restore a flattened session in place: re-inline every flattened tool_result
 * AND toolUseResult mirror from the backup, then DELETE the backup so a fully
 * restored session leaves zero artifacts behind. The reverse of flattenSession.
 *
 * We re-inline the live file (rather than copy the backup over it) so that any
 * content appended AFTER the last flatten — present in the live file but not yet
 * in the backup — is preserved. The backup is removed only on a clean restore
 * (every marker resolved); if anything was unresolved it is kept for inspection.
 */
export async function unflattenSession(
    filePath: string,
    backupPath: string
): Promise<UnflattenResult> {
    // Build id -> original-value map from the backup (the complete inlined session).
    let originals: Map<string, unknown>;
    try {
        const backupContent = await fs.readFile(backupPath, 'utf-8');
        originals = harvestOriginals(backupContent.trimEnd().split('\n'));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                sessionId: '', restoredCount: 0, notFound: [], originalSize: 0, newSize: 0,
                backupPath, skipped: `No backup found at ${backupPath}. Nothing to restore.`,
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
            if (originals.has(id)) {
                contentBlocks[i] = { ...block, content: originals.get(id) as ContentBlock['content'] };
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
                if (originals.has(id)) {
                    parsed.toolUseResult = originals.get(id);
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
        await writeFileAtomic(filePath, newContent);
    }

    // Self-cleaning: once every marker resolved, the backup has served its
    // purpose — remove it so a fully restored session leaves nothing behind. If
    // any marker was unresolved, keep the backup for inspection.
    if (notFound.length === 0) {
        try {
            await fs.unlink(backupPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    }

    return { sessionId, restoredCount, notFound, originalSize, newSize, backupPath };
}

/**
 * Retrieve an original payload from the backup by id. Streams the backup JSONL
 * line by line and returns the raw value (string, content-block array incl.
 * images, or toolUseResult object) so the caller can render text and images
 * appropriately. The id is either a tool_use_id (content slot) or
 * "<tool_use_id>#tur" (the toolUseResult mirror slot).
 */
export async function retrieveFlattened(
    backupPath: string,
    toolUseId: string
): Promise<RetrieveResult> {
    const wantMirror = toolUseId.endsWith(TUR_ID_SUFFIX);
    const baseId = wantMirror ? toolUseId.slice(0, -TUR_ID_SUFFIX.length) : toolUseId;

    const rl = readline.createInterface({
        input: createReadStream(backupPath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });

    // tool_use blocks (assistant) precede their tool_result, so a running map
    // back-fills the name/input label by the time we reach the target.
    const toolNameMap = new Map<string, { name: string; input: Record<string, unknown> }>();
    const availableIds: string[] = [];
    let found: RetrieveResult | null = null;
    let idx = -1;

    for await (const line of rl) {
        idx++;
        if (!line.trim()) continue;

        let parsed: (SessionMessage & { toolUseResult?: unknown });
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
            for (const block of parsed.message!.content as ContentBlock[]) {
                if (block.type === 'tool_use' && block.id && block.name) {
                    toolNameMap.set(block.id, { name: block.name, input: block.input ?? {} });
                }
            }
        }

        if (parsed.type !== 'user' || !Array.isArray(parsed.message?.content)) continue;

        let lineToolUseId: string | null = null;
        for (const block of parsed.message!.content as ContentBlock[]) {
            if (block.type !== 'tool_result') continue;
            if (!lineToolUseId && block.tool_use_id) lineToolUseId = block.tool_use_id;
            const c = block.content;
            if (!block.tool_use_id || c === undefined || c === null) continue;
            if (typeof c === 'string' && c.startsWith(MARKER_PREFIX)) continue;

            availableIds.push(block.tool_use_id);
            if (!found && !wantMirror && block.tool_use_id === baseId) {
                const info = toolNameMap.get(block.tool_use_id);
                const { kind, text } = classifyContent(c as string | ContentBlock[]);
                found = {
                    tool_use_id: toolUseId,
                    tool_name: info?.name ?? 'unknown',
                    original_size: valueByteSize(c),
                    line_count: text ? text.split('\n').length : 1,
                    kind: kind === 'none' ? 'text' : kind,
                    slot: 'content',
                    content: c,
                };
            }
        }

        if (parsed.toolUseResult != null) {
            const tur = parsed.toolUseResult;
            if (!(typeof tur === 'string' && tur.startsWith(MARKER_PREFIX))) {
                const base = lineToolUseId ?? `line${idx}`;
                availableIds.push(`${base}${TUR_ID_SUFFIX}`);
                if (!found && wantMirror && base === baseId) {
                    const info = lineToolUseId ? toolNameMap.get(lineToolUseId) : undefined;
                    found = {
                        tool_use_id: toolUseId,
                        tool_name: info?.name ?? 'unknown',
                        original_size: valueByteSize(tur),
                        line_count: typeof tur === 'string' ? tur.split('\n').length : 1,
                        kind: toolUseResultIsImage(tur) ? 'image' : 'text',
                        slot: 'toolUseResult',
                        content: tur,
                    };
                }
            }
        }
    }

    if (found) return found;

    // Cap the id list so a large backup doesn't produce a multi-KB error string.
    const shown = availableIds.slice(0, 20).join(', ');
    const more = availableIds.length > 20 ? ` (+${availableIds.length - 20} more)` : '';
    throw new Error(`id "${toolUseId}" not found in backup. Available IDs: ${shown}${more}`);
}
