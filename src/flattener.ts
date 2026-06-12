import { createReadStream, constants as FS_CONSTANTS } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import type { SessionMessage, ContentBlock } from './types.js';

export type FlattenKind = 'text' | 'image' | 'mixed';
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

/**
 * Raw tool_use block shape from the JSONL. Assistant tool_use blocks use
 * "id" (not "tool_use_id") in the actual Claude Code JSONL format.
 */
interface RawToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

/** Marker prefix used to tag a flattened payload, and matcher to read its id back. */
const MARKER_PREFIX = '[FLATTENED id=';
const MARKER_ID_RE = /^\[FLATTENED id=(\S+)\s/;

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
            // In raw JSONL, tool_use blocks have "id" field (not "tool_use_id")
            const raw = block as unknown as RawToolUseBlock;
            if (raw.type === 'tool_use' && raw.id && raw.name) {
                map.set(raw.id, {
                    name: raw.name,
                    input: raw.input ?? {},
                });
            }
        }
    }

    return map;
}

/**
 * Build a short summary of key arguments for the replacement marker.
 * E.g. Read { file_path: "/foo/bar.ts" } => "file_path=/foo/bar.ts"
 */
function summarizeArgs(input: Record<string, unknown>): string {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';

    const keyArgs = ['file_path', 'command', 'pattern', 'query', 'url', 'path', 'description', 'prompt'];
    const selected = entries
        .filter(([k]) => keyArgs.includes(k))
        .slice(0, 2);

    if (selected.length === 0) {
        selected.push(entries[0]);
    }

    return selected
        .map(([k, v]) => {
            const val = typeof v === 'string' ? v : JSON.stringify(v);
            const truncated = val.length > 80 ? val.slice(0, 77) + '...' : val;
            return `${k}=${truncated}`;
        })
        .join(', ');
}

/**
 * Classify a tool_result's content and project out its text. Handles three
 * real shapes seen in Claude Code JSONL:
 *   - string                         -> text
 *   - [{type:text}]                  -> text
 *   - [{type:image, source:{...}}]   -> image  (base64 screenshots — the bulk
 *                                       of session bloat by byte count)
 *   - [{type:text},{type:image}]     -> mixed
 */
function classifyContent(content: string | ContentBlock[] | undefined): {
    kind: FlattenKind | 'none';
    text: string;
    imageCount: number;
} {
    if (typeof content === 'string') {
        return { kind: 'text', text: content, imageCount: 0 };
    }
    if (Array.isArray(content)) {
        let text = '';
        let imageCount = 0;
        for (const b of content) {
            if (b.type === 'text' && b.text) {
                text += (text ? '\n' : '') + b.text;
            } else if (b.type === 'image') {
                imageCount++;
            }
        }
        const hasText = text.length > 0;
        const hasImage = imageCount > 0;
        // A non-empty array with no text/image block (e.g. tool_reference blocks)
        // is still classified 'text' so it gets flattened and stored verbatim,
        // rather than silently skipped — keeps flatten lossless for any block type.
        const hasOther = content.length > 0;
        const kind: FlattenKind | 'none' =
            hasImage && hasText ? 'mixed' : hasImage ? 'image' : hasText ? 'text' : hasOther ? 'text' : 'none';
        return { kind, text, imageCount };
    }
    return { kind: 'none', text: '', imageCount: 0 };
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

/** Byte size of any value exactly as it would sit inside the JSONL line. */
function valueByteSize(v: unknown): number {
    return typeof v === 'string'
        ? Buffer.byteLength(v, 'utf-8')
        : Buffer.byteLength(JSON.stringify(v), 'utf-8');
}

// ─── Context-token measurement ──────────────────────────────────────
// Why this exists: the disk byte-savings reported by flatten is a poor proxy
// for tokens removed from the model's context. ~half of a session file is
// metadata/mirror the model never sees, and images cost ~38 B/token vs ~3.5
// B/token for text — so bytes and tokens decouple. These helpers report the
// CONTEXT-token number instead, exact when an API key is present.

const TEXT_BYTES_PER_TOKEN = 3.5;   // Claude tokenizer ≈ 3.3–3.7 B/tok for English/code
const IMAGE_TOKEN_EST = 1500;       // typical screenshot tile cost; exact via count_tokens when keyed

/** Estimate the context-token cost of a flattened content value (text + images). */
function estimateContentTokens(content: unknown): { tokens: number; images: number } {
    if (typeof content === 'string') {
        return { tokens: Math.ceil(Buffer.byteLength(content, 'utf-8') / TEXT_BYTES_PER_TOKEN), images: 0 };
    }
    if (Array.isArray(content)) {
        let tokens = 0;
        let images = 0;
        for (const b of content as ContentBlock[]) {
            if (b.type === 'image') { tokens += IMAGE_TOKEN_EST; images++; }
            else if (b.type === 'text' && b.text) tokens += Math.ceil(Buffer.byteLength(b.text, 'utf-8') / TEXT_BYTES_PER_TOKEN);
            else tokens += Math.ceil(Buffer.byteLength(JSON.stringify(b), 'utf-8') / TEXT_BYTES_PER_TOKEN);
        }
        return { tokens, images };
    }
    if (content && typeof content === 'object') {
        return { tokens: Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf-8') / TEXT_BYTES_PER_TOKEN), images: 0 };
    }
    return { tokens: 0, images: 0 };
}

/** Flatten removed content values into Anthropic message blocks for count_tokens. */
function toCountBlocks(values: unknown[]): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const c of values) {
        if (typeof c === 'string') {
            if (c) blocks.push({ type: 'text', text: c });
        } else if (Array.isArray(c)) {
            for (const b of c as ContentBlock[]) {
                if (b.type === 'image' && b.source?.data) {
                    blocks.push({ type: 'image', source: { type: b.source.type || 'base64', media_type: b.source.media_type || 'image/png', data: b.source.data } });
                } else if (b.type === 'text' && b.text) {
                    blocks.push({ type: 'text', text: b.text });
                } else {
                    blocks.push({ type: 'text', text: JSON.stringify(b) });
                }
            }
        } else if (c && typeof c === 'object') {
            blocks.push({ type: 'text', text: JSON.stringify(c) });
        }
    }
    return blocks;
}

/**
 * Exact token count via Anthropic's free count_tokens endpoint. Returns null
 * when no ANTHROPIC_API_KEY is set or the call fails — caller falls back to the
 * local estimate. Uses global fetch (Node 18+); no SDK dependency added.
 */
async function countTokensExact(blocks: Array<Record<string, unknown>>): Promise<number | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || blocks.length === 0) return null;
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: process.env.FLATTEN_COUNT_MODEL || 'claude-haiku-4-5-20251001',
                messages: [{ role: 'user', content: blocks }],
            }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { input_tokens?: number };
        return typeof data.input_tokens === 'number' ? data.input_tokens : null;
    } catch {
        return null;
    }
}

/** Total tokens of an assistant turn's API usage = the real context size at that point. */
function usageContextTokens(usage: unknown): number {
    if (!usage || typeof usage !== 'object') return 0;
    const u = usage as Record<string, number>;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

/**
 * Build the compact replacement marker. Each identifier (id, session) appears
 * exactly ONCE; the retrieval protocol lives in the retrieve_flattened tool
 * description rather than being repeated verbatim in every marker.
 */
function buildMarker(args: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    kind: FlattenKind;
    size: number;
    lineCount: number;
    sessionId: string;
}): string {
    const { id, name, input, kind, size, lineCount, sessionId } = args;
    const argSummary = summarizeArgs(input);
    const argsPart = argSummary ? ` ${argSummary}` : '';
    const kindLabel = kind === 'image' ? 'image' : kind === 'mixed' ? 'text+image' : 'text';
    const restore = (kind === 'image' || kind === 'mixed')
        ? 'retrieve_flattened(id,session) to re-view image'
        : 'retrieve_flattened(id,session) for raw content';
    return `${MARKER_PREFIX}${id} tool=${name}${argsPart} | ${kindLabel} ${size}B/${lineCount}L | session=${sessionId} | ${restore}]`;
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
