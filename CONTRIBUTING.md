# Contributing to flatten-mcp

Issues and PRs are welcome. This page is the practical on-ramp.

## Dev setup

```bash
git clone https://github.com/shayaShav/flatten-mcp.git
cd flatten-mcp
npm install      # builds automatically via the "prepare" script
npm run dev      # tsc --watch
npm test         # vitest
npm run build    # one-off compile to dist/
```

Node >= 18. Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`); keep it that way.

## Project map

| File | Role |
| --- | --- |
| `src/core.ts` | Shared block logic: what gets flattened, markers, token estimates |
| `src/flattener.ts` | Disk engine over Claude Code session JSONL (backup model, atomic writes) |
| `src/session-store.ts` | Session discovery and selector resolution (`last N`, keyword, ...) |
| `src/index.ts` | The MCP server (three tools) |
| `src/lib.ts` | Library export: `flattenMessages` / `unflattenMessages` |
| `src/cli.ts` + `src/cli-core.ts` | `flatten-mcp-cli` — stdin/stdout adapter, no disk |
| `src/session-cli.ts` + `src/session-cli-core.ts` | `flatten-mcp-session` — terminal CLI over the session store |

Tests live in `tests/feature/<key>/` and import the pure cores directly — see
`docs/ARCHITECTURE.md` for the session format, backup model, and marker protocol.

## Workflow

1. Open a GitHub issue first — the issue number names the branch and any spec folder.
2. Branch from `main`: `feature/<issue#>-<kebab-name>` (or `chore/` / `docs/` for trivia
   that needs no issue).
3. Keep edits surgical; match the existing style (strict TypeScript, 4-space indentation,
   comments only where an invariant needs stating).
4. Add or extend tests for behavior changes; `npm run build` and `npm test` must pass
   (CI runs both on every PR).
5. Open a PR against `main` with `Closes #<issue#>` in the body. PRs merge via merge
   commit, and titles feed the auto-generated release notes.

## Security issues

See [SECURITY.md](SECURITY.md) — report privately, not via public issues.
