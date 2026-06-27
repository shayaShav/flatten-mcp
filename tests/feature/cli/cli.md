# stdin/stdout flatten CLI — feature doc

A language-agnostic command-line wrapper over the in-memory flatten engine
(`flattenMessages` / `unflattenMessages` in `src/core.ts`). It lets a caller in any
language — Python, Go, Ruby, shell — that holds a raw Anthropic Messages API
`messages[]` array flatten it without importing the JS library. No server, no MCP,
no disk, no network. (It still runs on Node; a Node-free standalone binary is out of
scope for now.)

## Binary

`package.json` exposes it as `flatten-mcp-cli` (`bin` → `dist/cli.js`). Run via
`npx flatten-mcp-cli ...` or the installed bin.

## Usage

```bash
# Flatten: stdin is a messages[] array, or {"messages":[...],"minSize"?:N}
echo '[{"role":"user","content":"hi"}]' | flatten-mcp-cli --flatten
flatten-mcp-cli --flatten --min-size 2000 < body.json > flattened.json

# Unflatten: stdin is the --flatten output ({messages, extracted}); extra keys ignored
flatten-mcp-cli --unflatten < flattened.json > restored.json
```

- `--flatten` prints `{messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved}`.
  Persist `extracted` yourself — you are the store.
- `--unflatten` prints `{messages}`, restored byte-for-byte.
- `--min-size N` overrides the 1000-byte default (CLI flag wins over an inline `minSize`).
- Bad usage / bad JSON → a message on stderr and exit code 1.

## Design

`src/cli-core.ts` holds the pure `runFlattenCli(argv, input) -> string` (throws
`CliUsageError`); `src/cli.ts` is the thin bin that wires stdin/stdout/argv and the
exit code. The split keeps the logic unit-testable without spawning a process and
mirrors the `core.ts` / `lib.ts` no-boot-hazard separation.

## Tests

`cli.test.ts` (Vitest) imports `runFlattenCli` directly: bare-array flatten, a
flatten→unflatten byte-for-byte round trip, the `{messages}` + `--min-size` form,
and the usage/bad-input error cases.

Run gates: `npm run build` (zero errors) and `npm test` (green).
