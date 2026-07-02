# Explicit exact-count opt-in + in-memory tools over Streamable HTTP

> Tracking issue: [#12](https://github.com/shayaShav/flatten-mcp/issues/12)

Two related trust-and-reach changes: the only network call now requires explicit
intent (not just key presence), and the in-memory engine gained an interactive
HTTP surface for hosted registry inspectors and remote MCP clients.

## Exact token counting requires explicit opt-in

The exact-count path (`POST api.anthropic.com/v1/messages/count_tokens` with the
flattened content) used to activate on `ANTHROPIC_API_KEY` presence alone. Many
users export that key globally, so the trigger was key presence rather than user
intent — while the README advertised zero network calls by default.

- **Disk path** (MCP `flatten_session` + `flatten-mcp-session` CLI): the call now
  requires **both** `FLATTEN_COUNT_EXACT` set to an affirmative value (`1`,
  `true`, `yes`, `on`; case-insensitive) **and** `ANTHROPIC_API_KEY`. Anything
  else keeps the run fully offline; savings stay a local estimate
  (`contextTokensExact: false`). Any API failure falls back silently to the
  estimate.
- **Library API**: unchanged. Calling `flattenMessagesExact` /
  `flattenRequestBodyExact` is itself the opt-in; `countExact: false` forces the
  estimate. `FLATTEN_COUNT_EXACT` has no effect on the library.
- **Request body, exactly**: the counting model id (`FLATTEN_COUNT_MODEL`,
  default `claude-haiku-4-5-20251001`) and a single user message whose content is
  the tool results being flattened, reduced to their text and image blocks; a
  second identical call counts the replacement markers. Nothing else is sent.
- Surfaced in the README Security/Configuration sections, `server.json`
  environment variables, and the MCPB `manifest.json` (boolean user config wired
  to `FLATTEN_COUNT_EXACT`).

## In-memory tools over Streamable HTTP (`flatten-mcp-http`)

The disk tools cannot meaningfully run remotely — they read and rewrite the local
Claude Code session store — which left hosted registry inspectors with nothing
interactive to call. The stateless in-memory engine is the one part of the
package that is location-independent, so it is now exposed as an MCP tool
surface:

- `src/inmemory-tools.ts` registers `flatten_messages` / `unflatten_messages`
  over the shared core (`core.ts`): flatten a raw Messages API `messages[]`
  array carried in the tool call, return the flattened copy plus `extracted`;
  the caller is the store, exactly like the library.
- `flatten-mcp-http` (bin; `src/http.ts` + `src/http-core.ts`) serves only those
  two tools over MCP Streamable HTTP: stateless (fresh server + transport per
  POST, `sessionIdGenerator: undefined`), plain JSON responses
  (`enableJsonResponse`), permissive CORS, `GET /` service info, 405/404
  elsewhere. Binds `127.0.0.1:8787` by default (`--port`/`--host`, `PORT`/`HOST`
  fallbacks); no auth — the tools are pure functions over the request's JSON,
  with no disk, no credentials, and no outbound network.
- `FLATTEN_INMEMORY_TOOLS=1` adds the same two tools to the stdio server, for
  hosted/containerized stdio deployments. Off by default: the local tool surface
  stays the three disk tools.
- The guidance in the in-memory API spec
  ([1-in-memory-flatten-api](../1-in-memory-flatten-api/1-in-memory-flatten-api.md))
  still holds for production callers: transporting the conversation moves the
  exact bulk the library avoids moving. The HTTP surface is a demo/integration
  path, and its tool descriptions say so.

`src/version.ts` now single-sources the in-code version for both server entries.

## Bin-name namespace claim (companion packages)

The README (since v2.0.1) printed `npx flatten-mcp-session` / `npx flatten-mcp-cli`,
but `npx <command>` resolves an npm **package** by that name — and none existed
(the bins ship inside `flatten-mcp`), so the commands failed on any machine
without the package installed, and the unregistered names were open to
typosquatting against every circulating copy of the old docs.

Fixed twice over:

- All README examples now use the always-correct `npx -y -p flatten-mcp <bin>`.
- `packages/flatten-mcp-session|cli|http` are companion packages — a one-line
  `bin.js` delegating via the new subpath exports (`flatten-mcp/session-cli`,
  `flatten-mcp/cli`, `flatten-mcp/http`) — that claim the three bin names on npm
  so the direct commands work and the names cannot be claimed by anyone else.
  They pin `flatten-mcp: ^2.1.0` (the first version with the subpath exports) and
  are deliberately **not** npm workspaces, so the root install/CI flow is
  untouched. Publish order: `flatten-mcp` first, then the companions.

## Status

Implemented and tested: `tests/feature/count-exact-opt-in/` (fetch stubbed; gate
matrix, fallback, library independence) and `tests/feature/http-inmemory/` (real
HTTP round-trip on an ephemeral port, stateless property, error paths).
