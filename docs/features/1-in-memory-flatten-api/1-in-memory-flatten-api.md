# In-Memory Flatten API — Feature Spec

> Tracking issue: [#1](https://github.com/shayaShav/flatten-mcp/issues/1)

A pure library export so code calling the raw Anthropic Messages API
(`POST /v1/messages`) can flatten a conversation **in-memory** — no server, no
HTTP transport, no MCP, no file on disk.

```ts
import { flattenMessages, unflattenMessages } from 'flatten-mcp';

const { messages, extracted, contextTokensSaved } = flattenMessages(myMessages);
// send `messages` to the API; persist `extracted` yourself (you are the store).
const original = unflattenMessages(messages, extracted); // byte-identical restore
```

Bulky `tool_result` blocks (large text output and base64 image/screenshot blocks)
larger than `minSize` (default 1000 bytes) are swapped for a compact
`[FLATTENED id=<tool_use_id> …]` marker; every other block is preserved verbatim.
The input array is deep-copied, never mutated.

## Public surface

- `flattenMessages(messages, opts?)` → `{ messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved, contextTokensExact }`. `opts.minSize?` sets the byte threshold (default 1000). `contextTokensSaved` is a local estimate; the sync variant never touches the network.
- `flattenMessagesExact(messages, opts?)` → `Promise<…>`. Same flattening; when `ANTHROPIC_API_KEY` is set (and `opts.countExact !== false`) it counts tokens exactly via Anthropic's free `count_tokens` endpoint and sets `contextTokensExact: true`. Falls back silently to the estimate otherwise.
- `unflattenMessages(messages, extracted)` → `ApiMessage[]`. Re-inlines every `tool_result` whose content matches `^\[FLATTENED id=(\S+)\s`; unmatched markers are left in place; last entry wins on duplicate ids.
- `flattenRequestBody` / `flattenRequestBodyExact` / `unflattenRequestBody` — whole-body wrappers. Take a full `{ system, messages, tools, … }` body, transform only `messages`, pass every other field through untouched on a new object.

Exported types: `ApiMessage`, `ContentBlock`, `FlattenKind`, `FlattenMessagesOptions`, `ExtractedEntry`, `FlattenMessagesResult`, `MessagesRequestBody`, `FlattenRequestBodyResult`.

## Why a library, not a transport

The in-memory path operates on the `messages[]` array already in the caller's
process. Routing a multi-MB body through any HTTP/MCP transport would move the
exact bulk we are trying to set aside, so this feature deliberately adds **no**
REST API, MCP-over-HTTP transport, or new MCP tool — the package's MCP tools stay
disk-oriented.

The transformed blocks are byte-identical to the raw Messages API block shapes
(`text`, `tool_use {id,name,input}`, `tool_result {tool_use_id, content, is_error?}`
with `content` as `string | block[]`, `image {source:{type:base64, media_type, data}}`).
Claude Code embeds the unmodified API `message` object, so the same block logic the
disk engine uses works on a raw `messages[]` array unchanged. The shared logic lives
in `src/core.ts`; `src/lib.ts` re-exports the public surface (and never imports the
stdio server entry, so importing the library boots nothing).

## Caveats

- **Prompt caching.** Flattening earlier messages changes the cached prefix and
  invalidates `cache_control` breakpoints from that point on. Flatten **before**
  establishing a cache breakpoint.
- **No `contextTokensTotal`.** A pre-send body has no `usage` object yet; only
  `contextTokensSaved` is returned.

## Status

Implemented and tested. The Vitest suite lives in `tests/feature/in-memory-flatten/`
and covers lossless round-trips, the deep-copy invariant, image fidelity, metrics,
the exact-count path, and the whole-body wrappers.
