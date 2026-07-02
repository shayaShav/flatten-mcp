# Architecture

This document describes the on-disk formats flatten-mcp operates on and the algorithms behind flatten / unflatten. It targets contributors; end-user docs live in the [README](../README.md).

## Layout

```
src/
  index.ts          MCP server — registers the 3 tools, validates input, formats output
  flattener.ts      disk flatten / unflatten / retrieve engine — the JSONL surgery
  session-store.ts  session discovery, id resolution, project/claude-dir resolution
  types.ts          shared interfaces for the session JSONL shape
  core.ts           shared core — marker protocol, classification, token estimation;
                    also the in-memory flatten API over raw Messages API messages[]
  lib.ts            package entry — re-exports the in-memory API (never imports index.ts)
  cli.ts            flatten-mcp-cli bin — stdin/stdout wrapper over the in-memory engine
  cli-core.ts       pure argv+stdin → stdout logic behind cli.ts (unit-testable)
  session-cli.ts    flatten-mcp-session bin — terminal CLI over the same disk engine
  inmemory-tools.ts MCP registrar for flatten_messages/unflatten_messages (in-memory engine)
  http.ts           flatten-mcp-http bin — argv/lifecycle wiring for the HTTP entry
  http-core.ts      Streamable HTTP server over the in-memory tools (stateless, unit-testable)
  version.ts        single in-code source for the package version
```

The server speaks MCP over stdio (`@modelcontextprotocol/sdk`) and makes no outbound network call except an **opt-in** one to Anthropic's `count_tokens` endpoint for exact token accounting (`FLATTEN_COUNT_EXACT=1` plus `ANTHROPIC_API_KEY` — key presence alone does not trigger it). The `flatten-mcp-http` bin serves the in-memory tools over Streamable HTTP (inbound only, stateless); the disk tools are never exposed over HTTP because they operate on the local session store.

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

## Backup model

flatten keeps a single side artifact: `<session>.jsonl.bak`. It is **the complete session, fully inlined** — the same line-delimited JSON format as the session file itself, with every flattened block in place (the originals, verbatim). There is no separate keyed store; the backup is just "the session as if you'd never flattened".

One invariant ties the two files together, re-established on every flatten:

- `backup = unflatten(live)` — the complete originals
- `live   = flatten(backup)` — the lightweight markers

Two helpers do the work in both directions:

- `harvestOriginals(lines)` reads a session's lines into an `id → original` map, keyed exactly as the markers reference them: content blocks by `tool_use_id`, `toolUseResult` mirrors by `<tool_use_id>#tur`.
- `inlineLines(lines, originals)` is the shared pass that replaces every resolvable marker with its original (both slots), leaving unmatched lines verbatim.

Originals are stored exactly as they appeared, so restore is byte-identical for Claude Code's canonical JSON — including mixed text+image results and raw mirror objects. Untouched lines, including your prompts, are copied through verbatim.

## Marker protocol

In the rewritten session, each extracted payload is replaced by a single-line marker:

```
[FLATTENED id=<id> tool=<name> <key=arg,…> | <kind> <bytes>B/<lines>L | session=<sid> | retrieve_flattened(id,session) for raw content]
```

The id and session id each appear **once**; the retrieval instructions live in the `retrieve_flattened` tool description rather than being repeated in every marker. `unflatten_session` and `retrieve_flattened` recover the id with `^\[FLATTENED id=(\S+)\s`.

## Flatten algorithm

1. Read the whole session file; split into lines.
2. Build the `tool_use_id → {name,input}` map from assistant lines.
3. For each `user` line, for every `tool_result` block larger than `min_size`: record the original, swap in a marker. Repeat for the `toolUseResult` mirror when enabled. Lines already carrying a marker are skipped, so a re-run only touches newly-arrived bulk and the reported metrics stay per-operation.
4. Track context tokens from the latest assistant turn's `message.usage` (`input + cache_read + cache_creation`) as the real context total; estimate tokens removed locally, or upgrade to an exact `count_tokens` result when `FLATTEN_COUNT_EXACT=1` and `ANTHROPIC_API_KEY` are both set.
5. Rebuild the backup as the complete inlined session — `inlineLines` resolves the markers already in the live file against the prior backup; bulk added since the last flatten is still inline and passes through. On the first flatten the backup is the verbatim pristine original.
6. **Write order is chosen for crash-safety** (see below).

### Crash-safety

The session file is irreplaceable, so writes are ordered so any interruption leaves it intact:

1. Write the **complete backup first** (sibling temp file + atomic `rename(2)`). It holds every original — old and new — so it is the safety net.
2. Rewrite the live session **second**, the same atomic way. A crash between the two leaves the live file's markers fully resolvable against the backup; on the same filesystem each file is always *fully* the old version or *fully* the new one — never truncated.

## Unflatten

Builds an `id → original` map from the backup (`harvestOriginals`), then re-inlines the live session with `inlineLines` — restoring every `tool_result` block and `toolUseResult` mirror whose marker id is found, via the same atomic rewrite. Re-inlining (rather than copying the backup over the live file) preserves any content appended *after* the last flatten. Ids present in the session but missing from the backup are reported in `notFound`; once every marker resolves cleanly, the backup is **deleted**, so a fully restored session leaves zero artifacts.

## Token accounting

| Constant | Value | Note |
| --- | --- | --- |
| `TEXT_BYTES_PER_TOKEN` | 3.5 | Claude tokenizer ≈ 3.3–3.7 B/token for English/code. |
| `IMAGE_TOKEN_EST` | 1500 | Typical screenshot tile cost; exact via `count_tokens` when opted in. |

Only `slot: "content"` removals reduce what the model sees, so only they count toward `contextTokensSaved`. The `toolUseResult` mirror contributes to `diskBytesSaved` only.

## On-disk artifacts

| File | Created by | Purpose |
| --- | --- | --- |
| `<session>.jsonl.bak` | flatten | The single backup: the complete session, fully inlined. Needed by retrieve / unflatten; rebuilt each flatten; **deleted** by a clean unflatten. |
| `<session>.jsonl.tmp-<pid>` | atomic write | Transient; renamed into place. A leftover means a crash mid-write. |

A flattened session leaves exactly one extra file (`.jsonl.bak`); a fully unflattened session leaves none. The model is self-cleaning — there is no separate prune step.
