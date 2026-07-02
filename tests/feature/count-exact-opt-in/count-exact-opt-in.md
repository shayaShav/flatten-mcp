# Exact token counting — explicit opt-in (issue #12)

> Tracking issue: [#12](https://github.com/shayaShav/flatten-mcp/issues/12)

The exact-count path (`POST api.anthropic.com/v1/messages/count_tokens` with the
flattened content) used to activate on `ANTHROPIC_API_KEY` presence alone. Many
environments export that key globally, so the trigger was key presence rather than
user intent — while the README advertised zero network calls by default.

Behavior (since this change):

- **Disk path** (MCP server `flatten_session` + `flatten-mcp-session` CLI, both via
  `flattenSession`): the network call requires **both** `FLATTEN_COUNT_EXACT` set to
  an affirmative value (`1`, `true`, `yes`, `on` — case-insensitive) **and**
  `ANTHROPIC_API_KEY`. Anything else (unset, `0`, `false`, `no`, `off`, blank) keeps
  the run fully offline and `contextTokensSaved` a local estimate
  (`contextTokensExact: false`).
- **Library API** (`flattenMessagesExact` / `flattenRequestBodyExact`): unchanged and
  unaffected by `FLATTEN_COUNT_EXACT`. Calling the async `*Exact` variant is itself
  the explicit opt-in; `opts.countExact: false` forces the estimate.
- On any API failure the disk path falls back silently to the estimate.

## What the tests cover

`count-exact-opt-in.test.ts` stubs `fetch` and the two env vars (so results do not
depend on the developer machine's real environment) and asserts:

1. Key alone → no network call, `contextTokensExact: false`, estimate still reported.
2. Key + `FLATTEN_COUNT_EXACT=1` → exactly two `count_tokens` calls (removed values,
   then markers), `contextTokensExact: true`, saved = removed − markers.
3. Each affirmative value enables; each non-affirmative value stays offline.
4. Opt-in without a key stays offline.
5. API failure under opt-in falls back to the estimate.
6. `flattenMessagesExact` still counts with key + default `countExact` and no
   `FLATTEN_COUNT_EXACT` — proving the env gate is disk-path only.
