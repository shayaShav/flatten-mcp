<p align="center">
    <img src="https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/assets/logo.png" alt="flatten-mcp logo" width="160">
</p>

# flatten-mcp

> Resume the **exact same conversation** at a lower token cost — without compacting it into a lossy summary.

<p align="left">
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/flatten-mcp.svg"></a>
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/flatten-mcp.svg"></a>
  <a href="https://github.com/shayaShav/flatten-mcp/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="https://nodejs.org"><img alt="Node &gt;= 18" src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&amp;logoColor=white"></a>
  <a href="https://modelcontextprotocol.io"><img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-6E56CF.svg"></a>
  <a href="https://docs.claude.com/en/docs/claude-code"><img alt="Built for Claude Code" src="https://img.shields.io/badge/built%20for-Claude%20Code-D97757.svg"></a>
  <a href="https://smithery.ai/server/@shaya-shaviv/flatten-mcp"><img alt="Smithery calls" src="https://smithery.ai/badge/@shaya-shaviv/flatten-mcp"></a>
</p>

**flatten-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io) server for [Claude Code](https://docs.claude.com/en/docs/claude-code). It shrinks a session's token footprint by moving bulky tool output (large file reads, command logs, base64 screenshots) out of the conversation and into a sidecar file — leaving a tiny, retrievable reference in its place. Your prompts and the chronological flow of the session are preserved **verbatim** — those lines are never rewritten. You resume the same raw conversation; it just costs less to carry.

See how 317,236 tokens turned into 182,287:

https://github.com/user-attachments/assets/4672b3cd-f78f-4146-97ba-e0077b655381

---

## Why flatten instead of compact?

The standard answer to a full context window is **compaction**: the model reads the whole conversation and rewrites it into a shorter summary. That summary is lossy by construction — an *interpretation* of your history, and interpretations drift, smooth over the awkward parts, and quietly drop the detail you didn't know you'd need. But the history is exactly what's worth keeping verbatim: the words you typed at 2 a.m., the precise order of events, the dead ends and the decisions. A fuzzy, half-formed prompt carries more raw truth about your intent than any tidy paragraph written *about* it after the fact — and preserving it untouched is the foundation of trust in a coding agent.

**Flattening is the opposite move.** It changes *nothing* about what was said. In most sessions the model reads a lot — large files, long logs, multiple sources — and keeps every byte of it in context, even though it has nearly always already **written down the conclusion in plain prose**: the one line that mattered in a 2 MB log, the finding distilled from five files, the running tally of open tasks. The raw source has done its job. Flattening lifts those already-summarized blocks out and swaps each for a lightweight reference ID — so starting cold from a flattened session is usually smooth sailing, and on the rare occasion the raw bytes *are* needed, they're one `retrieve_flattened` call away.

```
What sits in the context window:

   USER         "fix the crash"
   ASSISTANT    reading the logs…
   TOOL_RESULT  ▓▓▓ 2 MB log dump ▓▓▓        ← bulk; already summarized in prose below
   ASSISTANT    "the OOM is at line 88,402 — the fix is …"

After flatten — same words, only the bulk set aside:

   USER         "fix the crash"
   ASSISTANT    reading the logs…
   TOOL_RESULT  [FLATTENED id=… → sidecar]   ← one marker; fetch the full dump on demand
   ASSISTANT    "the OOM is at line 88,402 — the fix is …"
```

## What you'll actually save

Token reduction depends entirely on what the session did:

- **Read-heavy sessions** (lots of large files, logs, or screenshots in context) — expect reductions **up to ~50%**.
- **Prose-heavy sessions** (little external data ingested) — savings are negligible. There's simply not much bulk to move.
- It varies a lot — often a pleasant surprise, and once in a while a touch underwhelming.

**When to reach for it.** A common point is around **200k** tokens. For critical sessions where you want the model at its sharpest and most context-aware, flattening around **250k–300k** is where the most dramatic reductions tend to show up.

**Flatten smartly**, the same way you wouldn't compact mid-way through a large reading task. That said, nothing is ever lost — flattening everything and then cherry-picking the few blocks you still need is a perfectly legitimate strategy.

---

## Quick start

> Requires **Node.js ≥ 18** and **Claude Code**.

One command — installs from [npm](https://www.npmjs.com/package/flatten-mcp) and registers it user-wide:

```bash
claude mcp add flatten -s user -- npx -y flatten-mcp@latest
```

Or register it manually (in `~/.claude.json`, or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "flatten": {
      "command": "npx",
      "args": ["-y", "flatten-mcp@latest"]
    }
  }
}
```

Recommended — install the `/flatten` slash command:

```bash
curl -fsSL https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/commands/flatten.md -o ~/.claude/commands/flatten.md
```

<details>
<summary><b>From source</b> (for development)</summary>

```bash
git clone https://github.com/shayaShav/flatten-mcp.git
cd flatten-mcp
npm install      # builds automatically via the "prepare" script
cp commands/flatten.md ~/.claude/commands/   # optional: installs the /flatten command
```

Register the local build instead:

```json
{
  "mcpServers": {
    "flatten": {
      "command": "node",
      "args": ["/absolute/path/to/flatten-mcp/dist/index.js"]
    }
  }
}
```

</details>

### Uninstall

```bash
claude mcp remove flatten -s user       # unregister the server
rm -f ~/.claude/commands/flatten.md     # remove the /flatten command, if installed
```

Flatten artifacts (`.flat.jsonl` sidecars, `.bak` backups) live next to your session files and are not deleted by uninstalling. To reclaim the disk, run `prune_flatten_artifacts` (with `include_sidecars: true`) **before** unregistering — or delete them manually from `~/.claude/projects/<encoded-project-dir>/`. Mind that flattened sessions need their sidecar for `retrieve_flattened` / `unflatten_session` — unflatten first if you want the bulk back inline.

### Configuration

By default the server operates on **the project the CLI runs in** (its current working directory). Pass `project_dir` explicitly on any call to target a different project.

| Env var | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | no | If set, token savings are counted **exactly** via Anthropic's free `count_tokens` endpoint instead of estimated locally. |
| `FLATTEN_COUNT_MODEL` | no | Model id used for the exact token count (default: `claude-haiku-4-5-20251001`). |

## Usage

> [!CAUTION]
> **Always exit the session you want to flatten with `Ctrl-C`, then flatten it from a *different* window.** Rewriting a live session's file out from under Claude Code corrupts its in-memory state and bricks the session.

1. **Exit the session you want to flatten** with `Ctrl-C`. This is mandatory — a 10-second live-write guard refuses to touch a recently-modified session unless you force it, but exiting is the safe path.
2. In a **new** Claude Code window, type `/flatten latest` or `/flatten <session-id>` — or ask:
   > "Flatten the latest session."  ·  or  ·  "Flatten session `<session-id>`."

   `/flatten latest` (or bare `/flatten`) flattens the **larger** of the two most recent sessions — the smaller, seconds-old one is almost always the window doing the flattening itself, and the session worth flattening is the big one. It never forces past the live-write guard.

3. **Resume** your original session and send a prompt. When Claude starts outputting text, you'll see the token count drop.

To preview without touching anything, ask for a **dry run** first. To undo, ask to **unflatten** the session — every original block is restored to its exact original value.

> [!TIP]
> Flattening needs no model intelligence — park a second window on a fast, inexpensive model (`/model haiku`) as a dedicated flattening station and just type `/flatten latest`.

### Validate the claims yourself

Every number flatten reports can be checked end to end in a couple of minutes:

1. Pick a meaty session — or make one: have Claude read a few large files, then exit with `Ctrl-C`.
2. In a new window, ask for a **dry run** — *"dry-run flatten the latest session"* — and read the report: `flattenedCount`, `contextTokensSaved` of `contextTokensTotal`, `diskBytesSaved`. Nothing has been written yet.
3. Run `/flatten latest` for real, `claude --resume` the original session, and send any prompt — the context indicator drops by roughly the reported amount (exactly, when `ANTHROPIC_API_KEY` is set).
4. Check reversibility: ask to **unflatten** the session, then diff the restored `.jsonl` against the `.jsonl.bak` backup created at flatten time — identical for Claude Code's canonical JSON.

## Tools

| Tool | What it does |
| --- | --- |
| `flatten_session` | Move bulky tool results into a sidecar, leaving `[FLATTENED …]` markers. Crash-safe and reversible. Supports `dry_run`, `min_size`, `force`, and `include_tool_use_result`. |
| `retrieve_flattened` | Fetch one original block back by its id — returns the original text, or re-renders a flattened screenshot as a real image. |
| `unflatten_session` | Reverse a flatten completely: re-inline every block from the sidecar, restoring each flattened result to its exact original value. |
| `prune_flatten_artifacts` | Reclaim disk by deleting leftover `.bak` / `.tmp` files (and, opt-in, sidecars). Defaults to a safe dry run. |
| `list_sessions` | List a project's sessions with branch, message count, size, and first prompt. |
| `search_sessions` | Keyword / branch / date search across past sessions — scans prose, tool I/O, **and** flatten sidecars so nothing goes dark after flattening. |

When a session is flattened, the model sees compact markers like this in place of the original output:

```
[FLATTENED id=toolu_01AbC… tool=Read file_path=/src/server.ts | text 48213B/612L | session=2f9c… | retrieve_flattened(id,session) for raw content]
```

Everything the model needs to fetch the original — the id and the session — is right there in the marker.

## How it works

- **Sidecar, not deletion.** Each extracted block is written verbatim to `<session>.flat.jsonl` next to the session. The original session file is backed up **once** to `<session>.jsonl.bak` before the first rewrite.
- **Crash-safe.** Originals are persisted to the sidecar *before* they're removed from the session, and the session is rewritten via an atomic temp-file-and-`rename`, so an interrupted run can never leave a half-written, irreplaceable session file.
- **Idempotent.** Re-running flatten skips already-flattened blocks and never double-writes a sidecar entry.
- **Lossless & reversible.** Text and base64 images are stored exactly as they appeared, so `unflatten_session` restores each flattened block to its exact original value (byte-identical for Claude Code's canonical JSON). Your prompts and untouched lines were never altered to begin with.
- **Disk vs. context tokens.** Claude Code stores each tool result twice on disk (once in the API message, once in a `toolUseResult` mirror) and only one copy is ever sent to the model. flatten reports both `diskBytesSaved` (affects `--resume` parse speed) and `contextTokensSaved` out of `contextTokensTotal` (the number that actually matters for the context window and compaction) — they differ a lot, and the tool is explicit about which is which.

See [docs/ARCHITECTURE.md](https://github.com/shayaShav/flatten-mcp/blob/main/docs/ARCHITECTURE.md) for the session JSONL format, the sidecar schema, and the marker protocol.

## Security & disclosure

The entire server is four TypeScript files and two runtime dependencies ([`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [`zod`](https://www.npmjs.com/package/zod)) — it's a quick read.

- **File access.** Every read and write is confined to Claude Code's session store, `~/.claude/projects/<encoded-project-dir>/`. Rewriting session `.jsonl` files there is the tool's entire job, and each rewrite is backed up once and applied atomically (see [How it works](#how-it-works)). Nothing else on disk is ever touched.
- **Network.** Zero network calls by default. When `ANTHROPIC_API_KEY` is set, exactly one endpoint is contacted: `POST https://api.anthropic.com/v1/messages/count_tokens` (free) to report exact token savings. The request body is the content being flattened — the same tool output and screenshots Anthropic already processed in the session — sent only to Anthropic for counting. The key is read from the environment, sent only as the auth header, and never stored or logged. There is no other URL in the codebase.
- **No telemetry.** No analytics, no usage tracking, no phone-home.
- **No shell execution, no hooks.** The server spawns no processes, executes no shell commands, installs no hooks, and does not need permission bypasses.
- **Safe defaults.** The 10-second live-write guard refuses sessions that may still be active; `prune_flatten_artifacts` defaults to a dry run; the bundled `/flatten` command never passes `force`.
- **Prefer pinned versions?** The quick-start tracks `flatten-mcp@latest`; swap in an exact version (`npx -y flatten-mcp@1.0.1`) if you want to vet upgrades yourself.

## Compatibility & roadmap

- **Claude Code only, for now.** flatten-mcp reads Claude Code's session store at `~/.claude/projects/<encoded-project-dir>/*.jsonl`. It has been tested against Claude Code exclusively; the paths and the JSONL schema are specific to it and **will not work** for other agents or LLM CLIs as-is. Path handling is POSIX (macOS/Linux); Windows is untested.
- **Planned — a pluggable session backend.** Porting to other agents means abstracting the storage location and the on-disk message format behind a small adapter. Contributions welcome.

## Contributing

Issues and PRs are welcome. To develop locally:

```bash
npm install
npm run dev        # tsc --watch
npm run build      # one-off compile to dist/
```

## License

[MIT](LICENSE) © Shaya Shaviv
