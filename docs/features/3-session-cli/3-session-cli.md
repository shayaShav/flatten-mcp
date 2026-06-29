# Session CLI — flatten Claude Code sessions from the terminal

A `flatten-mcp-session` bin that drives the same on-disk engine as the MCP server, so a
session can be flattened, unflattened, listed, and retrieved straight from a shell — with no
running MCP server, no Claude Code session, and no LLM turn (zero tokens).

## What it does

`flatten-mcp-session` is the **disk/session** counterpart to `flatten-mcp-cli` (which is the
no-disk, in-memory `messages[]` adapter). It calls the exact functions the MCP tools call
(`flattenSession`, `unflattenSession`, `retrieveFlattened`) over the same session-store
resolution, so its behavior is identical to the `flatten_session` / `unflatten_session` /
`retrieve_flattened` tools.

```
flatten-mcp-session flatten   [<session>] [--dry-run] [--min-size N] [--no-tool-use-result]
flatten-mcp-session unflatten <session>
flatten-mcp-session list
flatten-mcp-session retrieve  <session> <tool_use_id> [--out <file>]
```

- **`<session>`** accepts a UUID, `last`, `last N`, `current`, or a keyword (matched against
  the first user message / git branch) — the same grammar as the MCP tool. `flatten` defaults
  to `current`, which outside Claude Code resolves to the most-recent session in the project.
- **Shared options:** `--project-dir <abs>` (default: current working directory),
  `--claude-dir <dir>` (default: `$CLAUDE_CONFIG_DIR` or `~/.claude`), `--json` for
  machine-readable output.
- **`flatten`** prints the same report fields as the MCP tool (`flattenedCount`,
  `contextTokensSaved` of `contextTokensTotal`, `diskBytesSaved`, percentages, `backupPath`).
- **`retrieve`** prints text content to stdout (a header goes to stderr, so a pipe stays
  clean) and writes image blocks to a file (`--out`, default `<tool_use_id>.<ext>`), since a
  terminal can't render base64.
- Bad usage, no match, or a downstream-closed pipe (`| head`) exits cleanly; other errors
  print to stderr and exit 1.

## Why

The MCP path costs an LLM turn (the model deciding to call the tool). Flattening needs no
model intelligence — it's pure file surgery — so a terminal entry point lets you flatten from
a script, a cron job, or another window with no token cost. It is the second adapter over the
same shared block logic, alongside the MCP disk tools and the in-memory CLI/library.

## Design

- The two session-location resolvers (`resolveProjectDir`, `resolveClaudeDir`) moved from the
  MCP server into `session-store.ts`, where `getSessionDir` / `resolveSessionId` already live;
  both the MCP server and the CLI import them, so resolution can't drift. A `listSessions`
  export was added for the `list` command.
- `src/session-cli.ts` is the new bin; the MCP server is otherwise unchanged.
- Wired as the `flatten-mcp-session` entry in `package.json` `bin`.

## How to test

From a clone, `npm run build`, then run against a throwaway copy of a session under a
temporary `--claude-dir` / `--project-dir`:

1. `flatten <id> --dry-run` reports counts without writing.
2. `flatten <id>` writes the lighter `.jsonl` and a complete `.jsonl.bak`.
3. `list` shows the session; `retrieve <id> <tool_use_id>` returns the original block.
4. `unflatten <id>` restores the session byte-for-byte and removes the backup.
