// In-memory flatten API — the no-storage adapter over the same block logic the
// disk engine uses. Operates on a raw Anthropic Messages API `messages[]` array
// (or a whole request body) already in the caller's process: no session file, no
// sidecar, and no network unless you opt into exact token counts via the async
// *Exact variants.
//
// The caller is the store: flattenMessages returns the extracted originals; the
// caller persists them and passes them back to unflattenMessages to restore.
//
// This module is also the SHARED CORE: the marker protocol, content
// classification, and token estimation live here as the single source of truth,
// and flattener.ts (the Claude Code disk adapter) imports them. The exported
// helpers stay package-private — lib.ts (the package entry) re-exports only the
// in-memory API, so the public surface is unchanged.
//
// It MUST NOT import ./index.ts — index.ts runs `await server.connect()` at the
// top level with no main-guard, so importing it would boot a stdio server.
// (flattener.ts imports core.ts, never the reverse, so there is no cycle and no
// boot hazard.)

import type { ContentBlock } from './types.js';

export type { ContentBlock } from './types.js';

/** A raw Anthropic Messages API message — exactly what the caller sends/receives. */
export type ApiMessage = {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
};

export type FlattenKind = 'text' | 'image' | 'mixed';

export interface FlattenMessagesOptions {
    /** Only flatten tool_result blocks whose serialized size exceeds this many bytes. */
    minSize?: number;
    /**
     * Only the async `*Exact` variants read this. When true (the default for
     * those variants) and `ANTHROPIC_API_KEY` is set, token savings are counted
     * exactly via Anthropic's free count_tokens endpoint; otherwise the local
     * estimate is used. Set false to force the estimate even with a key present.
     * The sync variants ignore it (they never make a network call).
     */
    countExact?: boolean;
}

/**
 * One extracted original, returned to the caller for persistence. Feed the same
 * array back to unflattenMessages to restore the conversation byte-for-byte.
 */
export interface ExtractedEntry {
    id: string;                       // tool_use_id — the marker key
    name: string;                     // originating tool name (or "unknown")
    input: Record<string, unknown>;   // originating tool input (or {})
    content: unknown;                 // ORIGINAL value, verbatim (string | ContentBlock[])
    size: number;                     // serialized byte size of the original
    lineCount: number;                // newline count of the original's text projection
    kind: FlattenKind;
}

export interface FlattenMessagesResult {
    messages: ApiMessage[];           // deep-copied, flattened — safe to send
    extracted: ExtractedEntry[];      // originals, for the caller to persist
    flattenedCount: number;
    imageBlocksFlattened: number;
    contextTokensSaved: number;       // local estimate, or exact via flattenMessagesExact
    contextTokensExact: boolean;      // true only when counted via count_tokens
}

/** A raw Messages API request body. Only `messages` is transformed; the rest passes through. */
export interface MessagesRequestBody {
    messages: ApiMessage[];
    [key: string]: unknown;           // system, tools, model, max_tokens, … — untouched
}

/** Result of flattening a whole request body: the body with `messages` flattened, plus metrics. */
export interface FlattenRequestBodyResult<T extends MessagesRequestBody> {
    body: T;                          // a NEW object; the input body is never mutated
    extracted: ExtractedEntry[];
    flattenedCount: number;
    imageBlocksFlattened: number;
    contextTokensSaved: number;
    contextTokensExact: boolean;
}

// ─── Shared core constants & helpers ────────────────────────────────
// core.ts is the single source of truth for the marker protocol and token
// estimation; flattener.ts (the Claude Code disk adapter) imports these so the
// logic exists in exactly one place. Anything exported here is still private to
// the package — lib.ts (the package entry) only re-exports the in-memory API, so
// these never widen the public surface.

/** Marker prefix tagging a flattened payload; matcher reads its id back. */
export const MARKER_PREFIX = '[FLATTENED id=';
export const MARKER_ID_RE = /^\[FLATTENED id=(\S+)\s/;

/** Default min size, matching the disk tool's min_size default (index.ts:127). */
const DEFAULT_MIN_SIZE = 1000;

// Local token estimators — shared by the disk and in-memory paths.
export const TEXT_BYTES_PER_TOKEN = 3.5;   // Claude tokenizer ≈ 3.3–3.7 B/tok for English/code
const IMAGE_TOKEN_EST = 1500;              // typical screenshot tile cost (core-internal)

// ─── Helpers ────────────────────────────────────────────────────────

/** Byte size of any value exactly as it would serialize. */
export function valueByteSize(v: unknown): number {
    return typeof v === 'string'
        ? Buffer.byteLength(v, 'utf-8')
        : Buffer.byteLength(JSON.stringify(v), 'utf-8');
}

/**
 * Build a short summary of key arguments for the replacement marker.
 * E.g. Read { file_path: "/foo/bar.ts" } => "file_path=/foo/bar.ts"
 *
 * Core-internal (only buildMarker calls it). Undefined-valued keys are dropped
 * up front: the in-memory API receives raw caller objects where optional fields
 * are routinely `undefined`, and `JSON.stringify(undefined)` returns `undefined`
 * (not a string), which would throw on `.length` below. The disk path is
 * unaffected — values parsed from JSON are never `undefined` — so its marker
 * output stays byte-identical.
 */
function summarizeArgs(input: Record<string, unknown>): string {
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '';

    const keyArgs = ['file_path', 'command', 'pattern', 'query', 'url', 'path', 'description', 'prompt'];
    const selected = entries.filter(([k]) => keyArgs.includes(k)).slice(0, 2);
    if (selected.length === 0) selected.push(entries[0]);

    return selected
        .map(([k, v]) => {
            const val = typeof v === 'string' ? v : JSON.stringify(v);
            const truncated = val.length > 80 ? val.slice(0, 77) + '...' : val;
            return `${k}=${truncated}`;
        })
        .join(', ');
}

/**
 * Classify a tool_result's content and project out its text. Handles every shape
 * the raw API allows for tool_result.content:
 *   - string                         -> text
 *   - [{type:text}]                  -> text
 *   - [{type:image, source:{...}}]   -> image  (base64 screenshots)
 *   - [{type:text},{type:image}]     -> mixed
 *   - any other non-empty array      -> text  (stored verbatim, never silently dropped)
 */
export function classifyContent(content: string | ContentBlock[] | undefined): {
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
        const hasOther = content.length > 0;
        const kind: FlattenKind | 'none' =
            hasImage && hasText ? 'mixed' : hasImage ? 'image' : hasText ? 'text' : hasOther ? 'text' : 'none';
        return { kind, text, imageCount };
    }
    return { kind: 'none', text: '', imageCount: 0 };
}

/** Estimate the context-token cost of a flattened content value (text + images). */
export function estimateContentTokens(content: unknown): { tokens: number; images: number } {
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

// ─── Exact token counting (opt-in, network) ─────────────────────────
// Shared by the disk adapter (flattener.ts) and the in-memory *Exact variants.
// Only reached when ANTHROPIC_API_KEY is set; otherwise callers use the estimate.

/** Flatten removed content values into Anthropic message blocks for count_tokens. */
export function toCountBlocks(values: unknown[]): Array<Record<string, unknown>> {
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
export async function countTokensExact(blocks: Array<Record<string, unknown>>): Promise<number | null> {
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

/**
 * Build the replacement marker, shared by both adapters. The `[FLATTENED id=<id>
 * ...]` shape and id grammar (id is the first whitespace-delimited token) are
 * identical so MARKER_ID_RE reads the id back the same way for either path; only
 * the tail differs:
 *   - disk adapter passes `sessionId` (even ''): the marker carries `session=…`
 *     and points at the retrieve_flattened MCP tool.
 *   - in-memory path omits `sessionId`: the marker points at unflattenMessages.
 * The two tails are mutually exclusive, so the output is byte-identical to what
 * each adapter produced before the helpers were unified.
 */
export function buildMarker(args: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    kind: FlattenKind;
    size: number;
    lineCount: number;
    sessionId?: string;
}): string {
    const { id, name, input, kind, size, lineCount, sessionId } = args;
    const argSummary = summarizeArgs(input);
    const argsPart = argSummary ? ` ${argSummary}` : '';
    const kindLabel = kind === 'image' ? 'image' : kind === 'mixed' ? 'text+image' : 'text';
    const head = `${MARKER_PREFIX}${id} tool=${name}${argsPart} | ${kindLabel} ${size}B/${lineCount}L`;
    if (sessionId !== undefined) {
        const restore = (kind === 'image' || kind === 'mixed')
            ? 'retrieve_flattened(id,session) to re-view image'
            : 'retrieve_flattened(id,session) for raw content';
        return `${head} | session=${sessionId} | ${restore}]`;
    }
    return `${head} | restore via unflattenMessages(messages, extracted)]`;
}

/**
 * Walk assistant messages and map tool_use_id -> { name, input }. tool_result
 * blocks carry only tool_use_id, not the tool name, so this back-fills the marker
 * label. In the raw API a tool_use block uses `id` (not `tool_use_id`).
 */
function buildToolNameMap(
    messages: ApiMessage[]
): Map<string, { name: string; input: Record<string, unknown> }> {
    const map = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const msg of messages) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            // A tool_use block carries its own `id` (the future tool_use_id).
            if (block.type === 'tool_use' && block.id && block.name) {
                map.set(block.id, { name: block.name, input: block.input ?? {} });
            }
        }
    }
    return map;
}

/** Deep copy a JSON-serializable value. structuredClone is built-in on Node 18+. */
function deepCopy<T>(value: T): T {
    return structuredClone(value);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * The shared flatten pass behind both the sync and async public variants.
 * Deep-copies `messages`, swaps every bulky tool_result for a marker, and
 * returns the originals plus the bookkeeping both variants need (the local
 * estimate, and the removed values + markers an exact count would re-measure).
 * The caller's input array is never mutated.
 */
function collectFlatten(messages: ApiMessage[], minSize: number): {
    messages: ApiMessage[];
    extracted: ExtractedEntry[];
    imageBlocksFlattened: number;
    estTokensSaved: number;
    removedValues: unknown[];
    markers: string[];
} {
    const copy = deepCopy(messages);
    const toolNameMap = buildToolNameMap(copy);

    const extracted: ExtractedEntry[] = [];
    const removedValues: unknown[] = [];
    const markers: string[] = [];
    let imageBlocksFlattened = 0;
    let estTokensSaved = 0;

    for (const msg of copy) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block.type !== 'tool_result') continue;

            const original = block.content;
            if (original === undefined || original === null) continue;
            // Idempotent: a tool_result already replaced by a marker is left alone.
            if (typeof original === 'string' && original.startsWith(MARKER_PREFIX)) continue;

            const size = valueByteSize(original);
            if (size <= minSize) continue;

            const { kind, text } = classifyContent(original);
            if (kind === 'none') continue;

            const lineCount = text ? text.split('\n').length : 1;
            const toolUseId = block.tool_use_id ?? 'unknown';
            const toolInfo = toolNameMap.get(toolUseId);
            const toolName = toolInfo?.name ?? 'unknown';
            const toolInput = toolInfo?.input ?? {};

            const marker = buildMarker({ id: toolUseId, name: toolName, input: toolInput, kind, size, lineCount });

            extracted.push({
                id: toolUseId,
                name: toolName,
                input: toolInput,
                content: original,
                size,
                lineCount,
                kind,
            });

            // Swap content for the marker; sibling fields (e.g. is_error) are kept.
            block.content = marker;
            removedValues.push(original);
            markers.push(marker);

            const est = estimateContentTokens(original);
            const markerTokens = Math.ceil(Buffer.byteLength(marker, 'utf-8') / TEXT_BYTES_PER_TOKEN);
            estTokensSaved += Math.max(0, est.tokens - markerTokens);
            imageBlocksFlattened += est.images;
        }
    }

    return { messages: copy, extracted, imageBlocksFlattened, estTokensSaved, removedValues, markers };
}

/**
 * Flatten an in-memory Messages API conversation. Deep-copies `messages`, then
 * for each user message swaps every bulky tool_result (> minSize) for a compact
 * `[FLATTENED id=…]` marker, stashing the original into `extracted`. The caller's
 * input array is never mutated. `contextTokensSaved` is a local estimate and
 * `contextTokensExact` is always false — use `flattenMessagesExact` for an exact
 * count.
 *
 * Message values must be JSON-serializable — the deep copy uses `structuredClone`,
 * which throws on functions/symbols (exactly the values a Messages API body never
 * contains).
 */
export function flattenMessages(
    messages: ApiMessage[],
    opts: FlattenMessagesOptions = {}
): FlattenMessagesResult {
    const r = collectFlatten(messages, opts.minSize ?? DEFAULT_MIN_SIZE);
    return {
        messages: r.messages,
        extracted: r.extracted,
        flattenedCount: r.extracted.length,
        imageBlocksFlattened: r.imageBlocksFlattened,
        contextTokensSaved: r.estTokensSaved,
        contextTokensExact: false,
    };
}

/**
 * Like `flattenMessages`, but when `ANTHROPIC_API_KEY` is set (and `countExact`
 * is not false) it reports `contextTokensSaved` exactly via Anthropic's free
 * count_tokens endpoint, setting `contextTokensExact: true`. Falls back silently
 * to the local estimate (and `contextTokensExact: false`) with no key, on any
 * API failure, or when there is nothing to flatten. The flattening itself is
 * identical to the sync variant; only the reported number can differ.
 */
export async function flattenMessagesExact(
    messages: ApiMessage[],
    opts: FlattenMessagesOptions = {}
): Promise<FlattenMessagesResult> {
    const r = collectFlatten(messages, opts.minSize ?? DEFAULT_MIN_SIZE);
    let contextTokensSaved = r.estTokensSaved;
    let contextTokensExact = false;

    if ((opts.countExact ?? true) && process.env.ANTHROPIC_API_KEY && r.removedValues.length > 0) {
        const removedExact = await countTokensExact(toCountBlocks(r.removedValues));
        const markerExact = await countTokensExact([{ type: 'text', text: r.markers.join('\n') }]);
        if (removedExact != null) {
            contextTokensSaved = Math.max(0, removedExact - (markerExact ?? 0));
            contextTokensExact = true;
        }
    }

    return {
        messages: r.messages,
        extracted: r.extracted,
        flattenedCount: r.extracted.length,
        imageBlocksFlattened: r.imageBlocksFlattened,
        contextTokensSaved,
        contextTokensExact,
    };
}

/**
 * Restore a flattened conversation. Builds an id -> original-content map from
 * `extracted` (last entry wins, matching the disk engine), deep-copies
 * `messages`, and re-inlines every tool_result whose content is a
 * `[FLATTENED id=…]` marker. Markers with no matching extracted entry are left
 * in place. The input array is never mutated.
 */
export function unflattenMessages(
    messages: ApiMessage[],
    extracted: ExtractedEntry[]
): ApiMessage[] {
    const valueById = new Map<string, unknown>();
    for (const entry of extracted) {
        valueById.set(entry.id, entry.content);
    }

    const copy = deepCopy(messages);

    for (const msg of copy) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;

            const match = block.content.match(MARKER_ID_RE);
            if (!match) continue;

            const id = match[1];
            if (!valueById.has(id)) continue;

            // Re-inline a fresh copy so the restored message never aliases the
            // caller's `extracted` store.
            block.content = deepCopy(valueById.get(id)) as ContentBlock['content'];
        }
    }

    return copy;
}

// ─── Whole-body convenience wrappers ────────────────────────────────
// For callers holding a full request body. Only `messages` is transformed;
// `system`, `tools`, `model`, and everything else pass through untouched on a
// NEW body object (the input body is never mutated).

/** Flatten the `messages` of a request body, passing every other field through. */
export function flattenRequestBody<T extends MessagesRequestBody>(
    body: T,
    opts: FlattenMessagesOptions = {}
): FlattenRequestBodyResult<T> {
    const r = flattenMessages(body.messages, opts);
    return {
        body: { ...body, messages: r.messages } as T,
        extracted: r.extracted,
        flattenedCount: r.flattenedCount,
        imageBlocksFlattened: r.imageBlocksFlattened,
        contextTokensSaved: r.contextTokensSaved,
        contextTokensExact: r.contextTokensExact,
    };
}

/** Async exact-count counterpart of `flattenRequestBody` (see `flattenMessagesExact`). */
export async function flattenRequestBodyExact<T extends MessagesRequestBody>(
    body: T,
    opts: FlattenMessagesOptions = {}
): Promise<FlattenRequestBodyResult<T>> {
    const r = await flattenMessagesExact(body.messages, opts);
    return {
        body: { ...body, messages: r.messages } as T,
        extracted: r.extracted,
        flattenedCount: r.flattenedCount,
        imageBlocksFlattened: r.imageBlocksFlattened,
        contextTokensSaved: r.contextTokensSaved,
        contextTokensExact: r.contextTokensExact,
    };
}

/** Restore a request body flattened by `flattenRequestBody*`; passes other fields through. */
export function unflattenRequestBody<T extends MessagesRequestBody>(
    body: T,
    extracted: ExtractedEntry[]
): T {
    return { ...body, messages: unflattenMessages(body.messages, extracted) } as T;
}
