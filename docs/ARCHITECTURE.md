# Architecture

This document describes the on-disk formats flatten-mcp operates on and the algorithms behind flatten / unflatten. It targets contributors; end-user docs live in the [README](../README.md).

## Layout

```
src/
  index.ts          MCP server — registers the 6 tools, validates input, formats output
  flattener.ts      flatten / unflatten / retrieve engine — the JSONL surgery
  session-store.ts  session discovery, id resolution, and keyword search
  types.ts          shared interfaces for the session JSONL shape
```

The server speaks MCP over stdio (`@modelcontextprotocol/sdk`) and has no network dependencies except an **optional** call to Anthropic's `count_tokens` endpoint for exact token accounting.

## Session storage

Claude Code stores one file per session as line-delimited JSON:

```
~/.claude/projects/<encoded-project-dir>/<session-uuid>.jsonl
```

`<encoded-project-dir>` is the project's absolute path with every `/` replaced by `-` (e.g. `/Users/x/proj` → `-Users-x-proj`). See `encodeProjectDir` / `getSessionDir` in `session-store.ts`.

### Line types

Each line is one event, discriminated by `type`:

| `type` | Meaning | Relevant fields |
| --- | --- | --- |
| `user` | A user turn. Carries typed text **and** `tool_result` blocks (tool output is attributed to the user turn that follows the tool call). | `message.content` |
| `assistant` | A model turn. Carries text and `tool_use` blocks. | `message.content`, `message.usage` |
| `system` | Metadata events. | `subtype` |
| `progress`, `file-history-snapshot`, `queue-operation` | Internal bookkeeping; ignored. | — |

`message.content` is either a string or an array of content blocks:

- `{ type: "text", text }`
- `{ type: "tool_use", id, name, input }` — on **assistant** lines. Note the field is `id`, not `tool_use_id`.
- `{ type: "tool_result", tool_use_id, content }` — on **user** lines. `content` is a string, or an array that may include `{ type: "image", source: { media_type, data } }` (base64 screenshots).

Because `tool_result` blocks only carry `tool_use_id`, flatten first scans every assistant line to build a `tool_use_id → { name, input }` map (`buildToolNameMap`) so markers can show which tool produced the bulk.

### The `toolUseResult` mirror

Each result line also carries a **top-level `toolUseResult`** field that duplicates the tool output outside the API `message`. Only the copy inside `message.content` is sent to the model; the mirror is disk-only. flatten can extract both — controlled by `include_tool_use_result` — which is why **disk** savings and **context-token** savings diverge.

## Sidecar format

Extracted payloads are appended to `<session>.flat.jsonl`, one JSON object per line:

```jsonc
{
  "id": "toolu_01AbC…",      // tool_use_id, or "<tool_use_id>#tur" for a mirror entry
  "slot": "content",          // "content" (API message) | "toolUseResult" (disk mirror)
  "name": "Read",
  "input": { "file_path": "…" },
  "content": "…",            // the ORIGINAL value, verbatim: string | block[] | object
  "size": 48213,
  "lineCount": 612,
  "timestamp": "…",
  "kind": "text"             // "text" | "image" | "mixed"
}
```

`content` is stored exactly as it appeared in the session, so unflatten restores each block to its original value (byte-identical for Claude Code's canonical JSON) — including mixed text+image results and raw mirror objects. Untouched lines, including your prompts, are copied through verbatim and never re-serialized.

## Marker protocol

In the rewritten session, each extracted payload is replaced by a single-line marker:

```
[FLATTENED id=<id> tool=<name> <key=arg,…> | <kind> <bytes>B/<lines>L | session=<sid> | retrieve_flattened(id,session) for raw content]
```

The id and session id each appear **once**; the retrieval instructions live in the `retrieve_flattened` tool description rather than being repeated in every marker. `unflatten_session` and `retrieve_flattened` recover the id with `^\[FLATTENED id=(\S+)\s`.

## Flatten algorithm

1. Read the whole session file; split into lines.
2. Build the `tool_use_id → {name,input}` map from assistant lines.
3. **Live-write guard:** unless `dry_run` or `force`, refuse if the file's mtime is younger than 10 s (likely an active session).
4. For each `user` line, for every `tool_result` block larger than `min_size`: stash the original as a sidecar entry, swap in a marker. Repeat for the `toolUseResult` mirror when enabled.
5. Track context tokens from the latest assistant turn's `message.usage` (`input + cache_read + cache_creation`) as the real context total; estimate tokens removed locally, or upgrade to an exact `count_tokens` result when `ANTHROPIC_API_KEY` is set.
6. **Write order is chosen for crash-safety** (see below).

### Crash-safety

The session file is irreplaceable, so writes are ordered so any interruption leaves it intact:

1. Append originals to the sidecar **first** (deduped against ids already present, so a re-run after a crash can't double-append).
2. Back up the original session **once** with `COPYFILE_EXCL` — an existing `.bak` is never overwritten with an already-flattened copy.
3. Rewrite the session via a sibling temp file + atomic `rename(2)`. On the same filesystem the session is therefore always *fully* the old version or *fully* the new one — never truncated.

## Unflatten

Builds an `id → original` map from the sidecar (last entry wins), then walks the session re-inlining every `tool_result` block and `toolUseResult` mirror whose marker id is found. Snapshots the flattened file to `<session>.preunflatten.bak` before writing, and uses the same atomic rewrite. Ids present in the session but missing from the sidecar are reported in `notFound`.

## Token accounting

| Constant | Value | Note |
| --- | --- | --- |
| `TEXT_BYTES_PER_TOKEN` | 3.5 | Claude tokenizer ≈ 3.3–3.7 B/token for English/code. |
| `IMAGE_TOKEN_EST` | 1500 | Typical screenshot tile cost; exact via `count_tokens` when keyed. |
| `ACTIVE_SESSION_THRESHOLD_MS` | 10000 | Live-write guard window. |

Only `slot: "content"` removals reduce what the model sees, so only they count toward `contextTokensSaved`. The `toolUseResult` mirror contributes to `diskBytesSaved` only.

## On-disk artifacts

| File | Created by | Purpose |
| --- | --- | --- |
| `<session>.flat.jsonl` | flatten | Sidecar holding original payloads. Needed by retrieve / unflatten. |
| `<session>.jsonl.bak` | flatten | One-time backup of the pre-flatten session. |
| `<session>.preunflatten.bak` | unflatten | Snapshot of the flattened session before restore. |
| `<session>.jsonl.tmp-<pid>` | atomic write | Transient; renamed into place. A leftover means a crash mid-write. |

`prune_flatten_artifacts` cleans the `.bak` / `.tmp` files (and, opt-in, sidecars).
