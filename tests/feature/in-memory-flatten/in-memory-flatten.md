# In-Memory Flatten API — feature

## What it does

A pure library export so code calling the raw Anthropic Messages API
(`POST /v1/messages`) can flatten a conversation **in-memory** — no server, no
HTTP, no MCP, no file.

```ts
import { flattenMessages, unflattenMessages } from 'flatten-mcp';

const { messages, extracted, flattenedCount, contextTokensSaved } = flattenMessages(myMessages);
// send `messages` to the API; persist `extracted` yourself.
// later, to restore the original conversation:
const original = unflattenMessages(messages, extracted);
```

Bulky `tool_result` blocks (large text output and base64 image/screenshot
blocks) larger than `minSize` (default 1000 bytes) are swapped for a compact
`[FLATTENED id=<tool_use_id> …]` marker string; every other block is preserved
verbatim. `flattenMessages` **deep-copies** its input, so the caller's array is
never mutated.

## Public surface

- `flattenMessages(messages, opts?)` → `{ messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved, contextTokensExact }`
  - `opts.minSize?: number` — byte threshold, default `1000`.
  - `messages` in the result is the deep-copied, flattened body — safe to send.
  - `extracted` holds the originals verbatim; **the caller is the store** —
    persist it and pass it back to `unflattenMessages`.
  - `contextTokensSaved` is a local estimate (`TEXT_BYTES_PER_TOKEN = 3.5`,
    `IMAGE_TOKEN_EST = 1500`), the same constants the disk engine uses;
    `contextTokensExact` is `false` (sync variant never calls the network).
- `flattenMessagesExact(messages, opts?)` → `Promise<FlattenMessagesResult>`
  - Same flattening as the sync variant; when `ANTHROPIC_API_KEY` is set (and
    `opts.countExact !== false`) it reports `contextTokensSaved` exactly via the
    free `count_tokens` endpoint and sets `contextTokensExact: true`. Falls back
    silently to the estimate with no key / on failure / nothing to flatten.
- `unflattenMessages(messages, extracted)` → `ApiMessage[]`
  - Builds an `id → content` map (last entry wins), deep-copies `messages`, and
    re-inlines every `tool_result` whose content matches `^\[FLATTENED id=(\S+)\s`.
    Markers with no matching entry are left in place.
- `flattenRequestBody(body, opts?)` / `flattenRequestBodyExact(body, opts?)` /
  `unflattenRequestBody(body, extracted)` — whole-body convenience wrappers. Take
  a full `{ system, messages, tools, … }`; only `messages` is transformed, every
  other field passes through untouched on a NEW body object (input never mutated).

Types exported: `ApiMessage`, `ContentBlock`, `FlattenKind`,
`FlattenMessagesOptions`, `ExtractedEntry`, `FlattenMessagesResult`,
`MessagesRequestBody`, `FlattenRequestBodyResult`.

## Verified contract

The blocks transformed are byte-identical to the raw Messages API block shapes —
`text`, `tool_use {id,name,input}`, `tool_result {tool_use_id, content, is_error?}`
(content `string | block[]`), `image {source:{type:base64, media_type, data}}`.
Claude Code embeds the unmodified API `message` object, so the same block logic
the disk engine uses works on a raw `messages[]` array. See
[docs/features/1-in-memory-flatten-api/1-in-memory-flatten-api.md](../../../docs/features/1-in-memory-flatten-api/1-in-memory-flatten-api.md)
for the verified block contract.

## How to run the tests

```bash
npm run build   # zero errors; tsc ignores tests/ (include = src/**/*)
npm test        # vitest run — the suite below
```

`tests/feature/in-memory-flatten/in-memory-flatten.test.ts` imports the **real**
public entry (`src/lib.ts`, so importing it also asserts the no-boot-hazard:
`lib.ts` never pulls in `index.ts`, which would boot a stdio server). Cases:

1. bulky `tool_result`s flattened; small ones (< `minSize`) left alone
2. markers replace content; `extracted` ids match the markers
3. lossless round-trip — every block kind restored deep-equal (string content,
   `tool_use`, `tool_result` string, `tool_result` array + base64 image, `is_error`)
4. base64 image `data` byte-intact; `media_type` preserved
5. deep-copy invariant — caller's input array unmodified after `flattenMessages`
6. no-`tool_result` body → `flattenedCount: 0`, `extracted: []`, output deep-equals input
7. metrics — `contextTokensSaved > 0`; `imageBlocksFlattened` counts images; `contextTokensExact === false`
8. (bonus) custom `minSize` respected; (bonus) idempotent re-flatten is a no-op
9. (bonus) undefined-valued tool input does not throw
10. (bonus) `unflatten` leaves an unmatched marker in place; (bonus) last-wins on duplicate ids
11. `flattenMessagesExact` (`countExact: false`) flattens identically to the sync variant and round-trips
12. whole-body wrappers — `flattenRequestBody` flattens only `messages`, passes `system`/`tools`/`model`/`max_tokens` through, never mutates the input body, and round-trips losslessly; the exact body variant matches the sync one

18 tests total, all green.

### E2E against real data

The round trip was additionally validated against a real Claude Code session
reconstructed into a raw `messages[]` (inner `message` objects taken verbatim),
consuming the **built, packed** package via `import 'flatten-mcp'`: 605 messages,
58 bulky `tool_result`s flattened (37 images, ~84k tokens saved), restored
byte-for-byte, input array unmutated. The whole-body wrappers and the exact-count
fallback were e2e-checked the same way, and the disk engine's output was proved
byte-identical (sha256 unchanged) after the shared-helper moves.

## Caveats

- **Prompt caching.** Flattening earlier messages changes the cached prefix and
  invalidates `cache_control` breakpoints from that point on. Flatten **before**
  establishing a cache breakpoint.
- **`contextTokensTotal` is not reported** for a pre-send body — there is no
  usage object yet. Only `contextTokensSaved` is returned (a local estimate, or
  exact via the `*Exact` variants when `ANTHROPIC_API_KEY` is set).
- **Network.** The sync functions never touch the network. The async `*Exact`
  functions call Anthropic's free `count_tokens` endpoint only when
  `ANTHROPIC_API_KEY` is set and `countExact !== false`; on any failure they fall
  back to the estimate.
