# In-Memory Flatten API — Feature Spec

> Library export so callers using the raw Anthropic Messages API in their own code can flatten a conversation in-memory — no server, no HTTP, no MCP.

## Status

| Field | Value |
| --- | --- |
| Branch | `feature/in-memory-flatten-api` (tracks `origin/feature/in-memory-flatten-api`) |
| Tracking issue | [shayaShav/flatten-mcp#1](https://github.com/shayaShav/flatten-mcp/issues/1) |
| Spec date | 2026-06-27 |
| State | **Implemented & tested (2026-06-28); full scope incl. §13 #10 and #11.** `src/core.ts` + `src/lib.ts` shipped with sync + async-exact + whole-body wrappers; shared helpers single-sourced in `core.ts`; `ContentBlock.id` typed (casts dropped). 18 Vitest cases green; build clean; disk output proved byte-identical; e2e round-trip verified against real session data via the packed package. Not yet committed/PR'd (awaiting request). |
| Risk | Low — new files only; the existing disk engine (`flattener.ts`/`index.ts`) is not touched. |

This spec is self-contained: a fresh session can implement the feature from this doc alone.

---

## 1. Goal

Let a developer calling `POST /v1/messages` directly (any stateless raw-API usage, billed per token, no Claude Code) flatten their conversation **in-memory** by importing a function:

```ts
import { flattenMessages, unflattenMessages } from 'flatten-mcp'
```

Pass the in-memory `messages[]` array; get back a flattened copy plus the extracted originals to persist and later restore. Bulky `tool_result` blocks are swapped for `[FLATTENED id=…]` markers; everything else is preserved verbatim.

## 2. Scope correction (why "HTTP" is NOT in this feature)

The word "HTTP" in the originating discussion described **how the user's code reaches Anthropic** (raw `POST /v1/messages`). It was never a requirement for flatten-mcp to expose a server. flatten-mcp stays a library/MCP package and **does not** gain:
- a REST API or HTTP server,
- MCP-over-HTTP transport,
- a new MCP tool for this (the package's MCP tools stay disk-oriented).

The correct surface for in-code use is a **pure library export** — a direct function call on the array already in memory. Routing a multi-MB body through any transport would move the exact bulk we're trying to set aside.

## 3. Background & rationale

- flatten-mcp today operates **only** on Claude Code session files at `~/.claude/projects/<dir>/<uuid>.jsonl`.
- The raw Messages API is **stateless** — Anthropic persists no session, there is no file — so flatten cannot touch raw-API conversations today. Conversation state lives entirely in the caller's process.
- The package already ships compiled ESM functions, so a pure library export is the natural fit. This is also the README's planned "pluggable session backend" made real: the in-memory path is the *no-storage adapter*; the file path becomes *the Claude Code adapter* over a shared core.

## 4. Verified data-structure contract (the load-bearing fact)

The feature rests on one claim: the content blocks the existing engine transforms are **byte-identical** to the raw Messages API block shapes. This was verified two independent ways — against Anthropic's authoritative API reference (bundled `claude-api` skill) **and** against real Claude Code session JSONL extracted from disk. Implementation MUST target exactly these shapes (do not hand-wave field names — match this table):

| Block | Messages API shape (authoritative) | Confirmed in real Claude Code JSONL | Code accessor |
| --- | --- | --- | --- |
| `text` | `{type:"text", text}` | identical | `block.text` (`flattener.ts:168`) |
| `tool_use` (assistant) | `{type:"tool_use", id, name, input}` | identical (CC adds an ignored `caller` field) | `block.id` / `block.name` / `block.input` (`flattener.ts:69-74,113-121`) |
| `tool_result` (user) | `{type:"tool_result", tool_use_id, content, is_error?}` | identical | `block.tool_use_id` / `block.content` (`flattener.ts:512-517`) |
| `tool_result.content` | `string \| block[]` | both string and array forms seen on disk | `classifyContent` handles both (`flattener.ts:163-192`) |
| `image` | `{type:"image", source:{type:"base64", media_type, data}}` | identical (640 KB base64 `data` confirmed) | `block.source.data` / `block.source.media_type` (`flattener.ts:228`, `index.ts:228`) |
| `usage` (response) | `{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` | all four present | `input + cache_read + cache_creation` (`flattener.ts:498`) |
| line wrapper | — (API has none) | `{type, message, timestamp, gitBranch, sessionId, toolUseResult, …}` | Claude-Code-only; absent from a raw API body |

**Conclusion:** Claude Code embeds the *unmodified* API `message` object. Inner blocks are the public Messages API verbatim. The only Claude-Code-specific elements are the line wrapper, the disk-only `toolUseResult` mirror, and the extra `caller` field inside `tool_use` (preserved verbatim, never read). The in-memory path therefore operates on a raw `messages[]` array with the same block logic and zero shape guesswork.

Re-confirm sources during implementation: the bundled `claude-api` skill (Messages API block/usage reference) and a fresh re-extraction from `~/.claude/projects/<dir>/*.jsonl`.

## 5. Feasibility test (already run — PASSED)

A round-trip was executed through the **actual shipping engine** on mock data shaped exactly to the source0 contract above — raw API blocks, **no `toolUseResult` mirror, no wrapper extras** (i.e. exactly a raw API body). All 10 assertions passed:

```
flatten: {flattenedCount:3, contextTokensSaved:4534, imageBlocksFlattened:1}
PASS  3 bulky tool_results flattened; small ones left
PASS  markers replaced content in 3 lines
PASS  contextTokensTotal read from usage (3000)
PASS  unflatten restoredCount === flattenedCount; notFound empty
PASS  every message.content restored byte-identical
PASS  image base64 data intact (12011 chars exact)
PASS  is_error sibling field preserved
```

**What it proves:** the engine's transform is lossless on raw-API-shaped blocks — the central feasibility claim. **Caveat:** it tested the *existing* engine as a proxy (the future `flattenMessages` will reuse the same helpers). It did NOT test the unbuilt `flattenMessages` API, nor the two new invariants (deep-copy guard, `lib.ts` no-boot-hazard). Those are covered by the committed Vitest suite below. The proof script was ad-hoc (run in scratch, not committed); §10 turns it into the real suite.

## 6. Public API design

### `src/core.ts`

> This block shows the original v1 design. The **shipped** surface is a superset
> (added by §13 #10/#11): `FlattenMessagesResult` also carries `contextTokensExact`,
> `FlattenMessagesOptions` also has `countExact?`, and `core.ts` additionally
> exports `flattenMessagesExact`, `flattenRequestBody`, `flattenRequestBodyExact`,
> `unflattenRequestBody`, plus the `MessagesRequestBody`/`FlattenRequestBodyResult`
> types. `core.ts` is no longer self-contained — it is the shared core the disk
> adapter imports. See §13 #10/#11 and the feature doc for the full surface.

```ts
type ApiMessage = { role: 'user' | 'assistant'; content: string | ContentBlock[] }

interface FlattenMessagesOptions { minSize?: number }   // default 1000, matches index.ts:127

interface ExtractedEntry {
    id: string            // tool_use_id — the marker key
    name: string
    input: Record<string, unknown>
    content: unknown      // ORIGINAL value, verbatim (string | ContentBlock[])
    size: number
    lineCount: number
    kind: 'text' | 'image' | 'mixed'
}

interface FlattenMessagesResult {
    messages: ApiMessage[]        // deep-copied, flattened
    extracted: ExtractedEntry[]   // originals, for the caller to persist
    flattenedCount: number
    imageBlocksFlattened: number
    contextTokensSaved: number    // local estimate in v1
}

function flattenMessages(messages: ApiMessage[], opts?: FlattenMessagesOptions): FlattenMessagesResult
function unflattenMessages(messages: ApiMessage[], extracted: ExtractedEntry[]): ApiMessage[]
```

- `flattenMessages` **deep-copies** `messages` first, then for each `user` message walks `tool_result` blocks > `minSize`, stashes the original into `extracted`, and replaces the block's `content` with a `[FLATTENED id=<tool_use_id> …]` marker string (same marker format as the disk engine).
- `unflattenMessages` builds an `id → content` map from `extracted` (last wins), walks `messages`, and re-inlines any `tool_result` whose `content` matches `^\[FLATTENED id=(\S+)\s`.
- v1 takes a `messages[]` array and a **local** token estimate (`TEXT_BYTES_PER_TOKEN`/`IMAGE_TOKEN_EST`). No network call.

### `src/lib.ts` (new)

Re-exports only from `core.ts`. **Must NOT import `index.ts`** — `index.ts:372-373` runs `await server.connect()` at top level with no main-guard, so importing it would boot a stdio server and hang.

### `package.json`

Add an `exports` map pointing the package root at `dist/lib.js` + `dist/lib.d.ts`; keep `bin` unchanged. `tsconfig` already emits `.d.ts` (`declaration: true`) and the package is already `"type": "module"`.

### Implementation note (history)

v1 shipped `core.ts` **self-contained** (re-implementing the small marker/classification helpers) to hold risk at zero. The single-source-of-truth refactor (TODO #10) has since landed: those helpers now live in `core.ts` and `flattener.ts` imports them — see §13 #10. The disk engine's output is byte-for-byte unchanged (regression-proved).

## 7. Key decisions & consequences (must hold)

1. **Caller is the store.** No sidecar file — `flatten` returns `extracted`; the caller persists it and passes it back to `unflatten`. No fire-and-forget.
2. **Deep-copy the input.** Returning a mutated caller array would corrupt the conversation reused on the next API call. New invariant vs the disk path — must be tested.
3. **Do not import `index.ts`** from the library entry (boot hazard).
4. **Metrics simplify.** No `toolUseResult` mirror, no disk-vs-context split — every removed `tool_result` directly cuts context tokens. Drop `diskBytesSaved`; `contextTokensTotal` is `null` for a pre-send body.
5. **Prompt-caching caveat (document).** Flattening earlier messages changes the cached prefix and invalidates `cache_control` breakpoints from that point. Flatten before establishing a cache breakpoint.

## 8. Lossless round-trip guarantees

Originals are stored verbatim (string, base64 image, mixed, and non-text/image `tool_result.content` arrays — all confirmed on disk). `unflatten` restores byte-identical blocks, preserving sibling fields like `is_error`.

## 9. Token accounting / metrics

- Default (sync `flattenMessages`/`flattenRequestBody`): local estimate via `TEXT_BYTES_PER_TOKEN` (3.5) and `IMAGE_TOKEN_EST` (1500) — same constants the disk engine uses. `contextTokensExact` is `false`.
- Exact (async `flattenMessagesExact`/`flattenRequestBodyExact`, TODO #11 — DONE): when `ANTHROPIC_API_KEY` is set and `opts.countExact !== false`, `contextTokensSaved` is counted via Anthropic's free `count_tokens` endpoint and `contextTokensExact` is `true`; silent fallback to the estimate otherwise. The `toCountBlocks`/`countTokensExact` helpers now live in `core.ts` (shared with the disk adapter).

## 10. Test plan

Location (per repo test convention): `tests/feature/in-memory-flatten/`
- `in-memory-flatten.test.ts` — Vitest, importing the **real** `flattenMessages`/`unflattenMessages`. Cases (all on source0-shaped mock data):
  1. bulky `tool_result`s flattened; small ones (< `minSize`) left alone
  2. markers replace content; `extracted` ids match the markers
  3. **lossless round-trip** — every block kind restored deep-equal (string content, `tool_use`, `tool_result` string, `tool_result` array + base64 image, `is_error`)
  4. base64 image `data` byte-intact; `media_type` preserved
  5. **deep-copy invariant** — caller's input array is unmodified after `flattenMessages`
  6. no-`tool_result` body → `flattenedCount: 0`, `extracted: []`, output deep-equals input
  7. metrics — `contextTokensSaved > 0`; `imageBlocksFlattened` counts images
- `in-memory-flatten.md` — feature doc (what it does, how to run, the verified contract).

Run gates: `npm run build` (zero errors) and `npm test` (green) before reporting.

## 11. Scope

**In:** `src/core.ts`, `src/lib.ts`, `package.json` exports + `vitest` devDep + `test` script, the Vitest suite + feature doc.

**Out (for now):** any HTTP server / REST endpoint; MCP-over-HTTP transport; a new MCP tool for this; non-JS consumers (a stdin/stdout CLI could be a later issue); server-side persistence of extracted originals; the `flattener.ts` helper-extraction refactor.

## 12. Open questions — RESOLVED

- Input shape: **both.** `messages[]` is the primitive (`flattenMessages`); `flattenRequestBody` wraps it for whole-body `{system, messages, tools, …}` callers, transforming only `messages` and passing the rest through untouched on a new object.
- Naming/record shape: settled — `flattenMessages`/`flattenMessagesExact`/`unflattenMessages` + `flattenRequestBody`/`flattenRequestBodyExact`/`unflattenRequestBody`; `ExtractedEntry` as in §6.
- `exports` map: `.` → `{ types: ./dist/lib.d.ts, import: ./dist/lib.js }` (ESM-only; no `require` condition — the package is `"type": "module"`).

## 13. Next TODOs

- [x] **1. `src/core.ts`** — `ApiMessage`/`ExtractedEntry`/`FlattenMessagesResult` types + `flattenMessages` (deep-copy via `structuredClone`, marker swap, local token estimate, image detection) + `unflattenMessages` (id→content restore). Matches the §4 contract; self-contained (re-implements marker/classification helpers, imports nothing from `flattener.ts`/`index.ts`).
- [x] **2. `src/lib.ts`** — re-exports only from `core.ts`; does not import `index.ts`.
- [x] **3. `package.json`** — `exports` map (root → `dist/lib.{js,d.ts}`), `main`/`types` repointed to `lib`, `vitest` devDep, `"test": "vitest run"`; `bin` unchanged.
- [x] **4. Vitest config** — `vitest.config.ts` (`include: tests/**/*.test.ts`, node env); `tests/` is outside `tsc` include (`src/**/*`) so `npm run build` ignores it.
- [x] **5. `tests/feature/in-memory-flatten/in-memory-flatten.test.ts`** — the 7 §10 cases + 2 bonus (custom `minSize`, idempotent re-flatten) against the real public entry (`src/lib.ts`, which also proves the no-boot-hazard). 9/9 green.
- [x] **6. `tests/feature/in-memory-flatten/in-memory-flatten.md`** — feature doc.
- [x] **7. Verify** — `npm run build` zero errors; `npm test` 9/9 green; e2e: packed package imported by name round-trips 605 real messages (58 flattened, 37 images, ~84k tokens saved) losslessly with input unmutated.
- [x] **8. Docs** — README "Library API" section + prompt-caching caveat; roadmap line updated to "no-storage adapter shipped".
- [ ] **9. Commit** on this branch; open PR referencing issue #1 (only when asked).
- [x] **10. Done (2026-06-27).** Lifted the shared helpers (`MARKER_PREFIX`, `MARKER_ID_RE`, `TEXT_BYTES_PER_TOKEN`, `IMAGE_TOKEN_EST`, `summarizeArgs`, `classifyContent`, `valueByteSize`, `estimateContentTokens`, `buildMarker`, `FlattenKind`) into `core.ts` as the single source of truth; `flattener.ts` now imports them (−147 lines of duplication) and is the Claude Code disk adapter over the shared core. `buildMarker` was unified with an optional `sessionId`: present → disk tail (`session=… | retrieve_flattened…`), omitted → in-memory tail (`restore via unflattenMessages…`); the two tails are mutually exclusive so neither adapter's output changes. **Regression-proof:** flattening a copy of a real 605-message session produced byte-identical output before vs after (sha256 of the rewritten main file AND the sidecar both unchanged: `a1fcbada…` / `bd53fbba…`; 121 flattened, 8226793 disk bytes, 83216 tokens, 37 images — all identical). The helper exports stay package-private (the `exports` map only exposes `dist/lib.js`).
- [x] **11. Done (2026-06-28).** Whole-body input + exact `count_tokens`, plus the `ContentBlock.id` cast cleanup, all shipped. (a) `flattenMessagesExact`/`flattenRequestBodyExact` (async) count exactly via `count_tokens` when `ANTHROPIC_API_KEY` is set + `countExact !== false`, else fall back to the estimate; `contextTokensExact` flag added to the result; `toCountBlocks`/`countTokensExact` moved into `core.ts` (shared, disk output unchanged). (b) `flattenRequestBody`/`unflattenRequestBody` take the whole `{system,messages,tools,…}` body, transform only `messages`, never mutate input. (c) Added `id?: string` to `ContentBlock` (`types.ts`) and dropped the `as unknown as` casts in both `core.ts` and `flattener.ts` (removed `RawToolUseBlock`). 18 Vitest cases green; disk output re-proved byte-identical (sha256 `a1fcbada…`/`bd53fbba…` unchanged); all six functions resolve via `import 'flatten-mcp'` from the packed package.

## 14. References

- Issue: [shayaShav/flatten-mcp#1](https://github.com/shayaShav/flatten-mcp/issues/1)
- `src/flattener.ts` — shared pure helpers now relocated to `core.ts` and imported here (TODO #10 done); file I/O loops left untouched; the `id` (not `tool_use_id`) field on tool_use blocks is read via a local cast, confirmed on disk.
- `src/types.ts` — `ContentBlock` (16-26) is the literal API block shape.
- `src/index.ts` — top-level `await server.connect()` (372-373): the boot hazard behind decision #3; tool schemas (119-184) as a template only.
- `docs/ARCHITECTURE.md` — sidecar verbatim-store (60, 68) + disk-vs-context rationale (46-49, 109) the in-memory model simplifies.
- `README.md` — "pluggable session backend" roadmap line this realizes.
- Bundled `claude-api` skill — authoritative Messages API block/usage reference used for the §4 contract.
