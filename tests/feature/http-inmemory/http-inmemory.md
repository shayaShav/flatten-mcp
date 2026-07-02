# In-memory tools over Streamable HTTP (`flatten-mcp-http`)

> Tracking issue: [#12](https://github.com/shayaShav/flatten-mcp/issues/12)

`flatten-mcp-http` serves the in-memory engine (`flatten_messages` /
`unflatten_messages`, see `src/inmemory-tools.ts`) over MCP Streamable HTTP so
hosted registry inspectors and remote MCP clients can call it interactively. It is
stateless — a fresh `McpServer` + transport pair per POST (`sessionIdGenerator:
undefined`, `enableJsonResponse: true`), so no session tracking and plain
`application/json` responses.

The disk tools are deliberately not exposed over HTTP: they operate on the local
Claude Code session store, which does not exist wherever a remote client calls
from. The same registrar can be added to the stdio server with
`FLATTEN_INMEMORY_TOOLS=1` (off by default to keep the local tool surface lean).

Surface: `POST /mcp` (MCP), `GET /` (service info), `GET|DELETE /mcp` 405,
anything else 404, permissive CORS with `OPTIONS` preflight — no auth, no disk,
no outbound network; the tools are pure functions over the request's JSON.

## What the tests cover

`http-inmemory.test.ts` boots the real server from `createFlattenHttpServer()` on
an ephemeral port and asserts over actual HTTP:

1. `GET /` service info (name, endpoint, tool list).
2. `initialize` handshake returns the server identity.
3. `tools/list` works with no prior initialize on the connection — the stateless
   property hosted platforms rely on.
4. `flatten_messages` -> `unflatten_messages` round-trips byte-identically over the
   wire; marker format, extracted entries, and metrics (`contextTokensExact` always
   `false` — the sync engine never calls the network).
5. `min_size` is honored.
6. `GET /mcp` 405, unknown path 404, `OPTIONS` preflight 204 with CORS headers.
