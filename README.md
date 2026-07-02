<p align="center">
    <img src="https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/assets/logo.png" alt="flatten-mcp logo" width="160">
</p>

# flatten-mcp

> Move the bulk out of a Claude Code session — the huge file reads, logs, and screenshots
> the model already digested — into a local backup, fully reversibly. On Pro/Max that means
> compaction fires later and the model stays sharp; on API billing it means paying for
> fewer tokens. Every prompt and event stays verbatim.

<p align="left">
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/flatten-mcp.svg"></a>
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/flatten-mcp.svg"></a>
  <a href="https://github.com/shayaShav/flatten-mcp/actions/workflows/test.yml"><img alt="tests" src="https://github.com/shayaShav/flatten-mcp/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://github.com/shayaShav/flatten-mcp/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="https://modelcontextprotocol.io"><img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-6E56CF.svg"></a>
  <a href="https://docs.claude.com/en/docs/claude-code"><img alt="Built for Claude Code" src="https://img.shields.io/badge/built%20for-Claude%20Code-D97757.svg"></a>
</p>

<p align="center"><b>340,071 → 132,800 tokens — a 61% lighter session, every line of history intact.</b><br>
<sub>macOS · Linux · WSL2 — native Windows untested</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/assets/flatten-demo.gif" alt="Demo: a 340,071-token Claude Code session is flattened, /resume'd, and comes back 61% lighter at 132,800 tokens — history verbatim" width="820">
</p>

Most of a long session's tokens are raw source the model already **distilled into prose** —
the 2 MB log it boiled down to one line, the screenshot it described, the five files it
summarized. flatten-mcp moves that bulk into a local backup next to the session and leaves
a small `[FLATTENED …]` marker in its place. Nothing is rewritten, nothing is summarized
away; any block is one call from coming back. The whole thing is a handful of small
TypeScript files with two direct dependencies — small enough to audit in one sitting.

|  | `/compact` | Auto tool-result clearing | **flatten-mcp** |
| --- | --- | --- | --- |
| What happens | history rewritten into a summary | old tool results cleared as the limit nears | bulk moved to a local backup, markers remain |
| Lossy? | yes — an interpretation | cleared content is gone from context | no — byte-identical restore any time |
| You choose when? | you or the auto-cliff | automatic | yes |
| Session file on disk | rewritten | unchanged | shrinks; the backup keeps every original |

**Taste it first — nothing installed, nothing written:**

```bash
npx -y -p flatten-mcp flatten-mcp-session flatten --dry-run
```

Run it from a project you use Claude Code in: it prints the exact savings a flatten
would give your most recent session and writes nothing.

## Quick start

Runs through `npx` — no global install, nothing added to your project. Every read/write
stays inside Claude Code's own session store under `~/.claude/projects/`, and there are
zero network calls by default. (Node ≥ 18, which Claude Code already runs on.)

**1. Install** — either path:

```bash
# Terminal: register the server user-wide (pinned; use @latest if you prefer auto-updates)
claude mcp add flatten -s user -- npx -y flatten-mcp@2.1.0

# Optional: the /flatten slash command
curl -fsSL https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/commands/flatten.md -o ~/.claude/commands/flatten.md
```

```bash
# Or as a Claude Code plugin — registers the server AND bundles /flatten in one step
claude plugin marketplace add shayaShav/flatten-mcp
claude plugin install flatten-mcp@flatten-mcp
```

**2. Restart Claude Code (or open a new session)** — an already-open session does not pick
up a newly added server. Check with `/mcp`: `flatten` should be listed as connected.

**3. Use it — two steps, always:**

```
/flatten     → the session file is rewritten in place (a complete backup is written FIRST — nothing is ever lost)
/resume      → switch to another session and back; the reloaded copy is the lighter one
```

Until you `/resume`, the window you are in still holds the full pre-flatten copy in memory —
nothing will look different. After it, watch the context indicator drop.

<details>
<summary><b>Manual registration / from source</b></summary>

In `~/.claude.json` or your project's `.mcp.json`:

```json
{
    "mcpServers": {
        "flatten": { "command": "npx", "args": ["-y", "flatten-mcp@2.1.0"] }
    }
}
```

For development: `git clone https://github.com/shayaShav/flatten-mcp.git && cd flatten-mcp
&& npm install`, then point the config at `node /absolute/path/to/dist/index.js`.

</details>

## Usage

- Bare `/flatten` (or asking *"flatten this session"*) targets the **current** session — the
  server identifies it from `CLAUDE_CODE_SESSION_ID`. Pass a UUID to target another session.
- Preview first with a **dry run** — *"dry-run flatten this session"* — nothing is written.
- Undo completely by asking to **unflatten**: every block returns to its exact original value.
- Don't flatten a session that is mid-generation; flatten between turns, or from a second
  window — which also keeps the tool schemas out of your working session entirely.

> [!TIP]
> Flattening is pure file surgery — no model intelligence involved — so a fast, inexpensive
> model (`/model haiku`) flattens just as well as a frontier one.

## What you'll actually save

The reduction is the bulk you remove, not a fixed percentage:

- **Read-heavy sessions** (large files, long logs, screenshots): the demo above measured
  **340,071 → 132,800 tokens, a 61% cut**. The more ingested bulk, the bigger the cut —
  base64-screenshot-heavy sessions can go higher.
- **Prose-heavy sessions** (little external data): savings are small — there's not much
  bulk to move.

A common point to reach for it is around **200k** tokens; the most dramatic cuts show up
at 250k–400k. It's repeatable — a re-flatten only touches bulk that arrived since the last
one. The three tool schemas cost **~1,200 tokens per turn** while the server is connected;
one flatten of a read-heavy session removes orders of magnitude more from every later turn
(207k in the demo), and the separate-window pattern above makes even that overhead zero.

## Tools

| Tool | What it does |
| --- | --- |
| `flatten_session` | Move bulky tool results into the backup, leaving `[FLATTENED …]` markers. Crash-safe, reversible. No argument = current session; supports `dry_run`, `min_size`, `include_tool_use_result`. |
| `retrieve_flattened` | Fetch one original block back by id — text, or a flattened screenshot re-rendered as a real image. |
| `unflatten_session` | Reverse everything: re-inline every block from the backup, then delete the backup. |

In a flattened session the model sees markers like this, carrying everything needed to fetch
the original:

```
[FLATTENED id=toolu_01AbC… tool=Read file_path=/src/server.ts | text 48213B/612L | session=2f9c… | retrieve_flattened(id,session) for raw content]
```

## How it works

- **One backup, not deletion.** `<session>.jsonl.bak` holds the complete session fully
  inlined; the live file carries markers. Kept in lockstep every run
  (`backup = unflatten(live)`, `live = flatten(backup)`).
- **Crash-safe.** Originals are written to the backup *before* bulk leaves the session,
  each write via atomic temp-file-and-rename — an interrupted run can't leave a
  half-written session.
- **Self-cleaning.** A full unflatten restores everything inline and deletes the backup —
  zero artifacts left.
- **Re-flatten friendly.** As the session grows, run it again; only new bulk is touched,
  and content added after a flatten is never lost on restore.
- **Lossless.** Text and base64 images are stored exactly as they appeared —
  `unflatten_session` restores byte-identical values.
- **Honest numbers.** Claude Code stores each tool result twice on disk but sends one to
  the model; reports separate `diskBytesSaved` from `contextTokensSaved` (the number that
  matters), estimated locally — or exact via `count_tokens` when you opt in with
  `FLATTEN_COUNT_EXACT=1` (plus `ANTHROPIC_API_KEY`).

Details — session JSONL format, backup model, marker protocol — in
[docs/ARCHITECTURE.md](https://github.com/shayaShav/flatten-mcp/blob/main/docs/ARCHITECTURE.md).

**Validate the claims yourself:** (1) pick a meaty session; (2) ask for a dry run and read
the report; (3) `/flatten` for real, `/resume`, and watch the context indicator drop by the
reported amount; (4) diff `<session>.jsonl.bak` against a pre-flatten copy if you kept one,
then unflatten and confirm the restore is byte-identical.

## Security & verification

- **Provenance you can check.** Every release is published from CI via npm **trusted
  publishing (OIDC)** with **provenance attestations**, from a **signed tag** — no npm
  token exists anywhere. Verify: `npm audit signatures`. Pin an exact version (as the
  Quick start does) and the committed `package-lock.json` documents the tree we test
  against; `npx` resolves the two direct dependencies' own trees at install time — audit
  with `npm ls --omit=dev`.
- **File access.** Confined to the session store,
  `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded-project-dir>/` — rewriting session
  files there is the tool's entire job, always backup-first and atomic. The one exception:
  `flatten-mcp-session retrieve --out` writes a retrieved image where you tell it to.
- **Network.** Zero outbound calls unless you explicitly opt in to exact token counts.
  With **both** `FLATTEN_COUNT_EXACT=1` and `ANTHROPIC_API_KEY` set — key presence alone
  is not enough — exactly one endpoint is ever contacted:
  `POST api.anthropic.com/v1/messages/count_tokens` (free). The request body contains the
  counting model id (`FLATTEN_COUNT_MODEL`) and a single user message holding the tool
  results being flattened, reduced to their text and image blocks; a second identical call
  counts the replacement markers. Sent only to Anthropic; the key is read from the
  environment and never stored or logged. There is no other outbound URL in the codebase.
  The optional `flatten-mcp-http` bin (below) accepts *inbound* connections when you run
  it — localhost by default — and makes no outbound calls.
- **No telemetry, no shell, no hooks.** No analytics, no spawned processes, no permission
  bypasses. Vulnerability reports: [SECURITY.md](SECURITY.md).

## Beyond Claude Code — CLI & library

The same engine ships as a terminal CLI, an in-memory library, and a Streamable HTTP
server, so raw Messages API callers (any language) get the identical flatten/unflatten
semantics with no MCP and no session files.

<details>
<summary><b><code>flatten-mcp-session</code> — flatten Claude Code sessions from the terminal (no LLM turn, zero tokens)</b></summary>

```bash
npx -y -p flatten-mcp flatten-mcp-session flatten                     # most-recent session in this project
npx -y -p flatten-mcp flatten-mcp-session flatten <session> --dry-run
npx -y -p flatten-mcp flatten-mcp-session list
npx -y -p flatten-mcp flatten-mcp-session unflatten <session>
npx -y -p flatten-mcp flatten-mcp-session retrieve <session> <tool_use_id> --out shot.png
```

- `<session>`: UUID, `last`, `"last N"`, `current`, or a keyword — same grammar as the MCP
  tool. Shared flags: `--project-dir`, `--claude-dir`, `--json`.
- Drives the exact same on-disk engine as the MCP server — ideal for cron and scripts.
  After a real flatten, `/resume` the session in Claude Code to load the lighter copy.

</details>

<details>
<summary><b><code>flatten-mcp-cli</code> — flatten a raw Messages API conversation over stdin/stdout</b></summary>

```bash
echo '[{"role":"user","content":"hi"}]' | npx -y -p flatten-mcp flatten-mcp-cli --flatten
npx -y -p flatten-mcp flatten-mcp-cli --flatten --min-size 2000 < body.json > flattened.json
npx -y -p flatten-mcp flatten-mcp-cli --unflatten < flattened.json > restored.json
```

- `--flatten` prints `{ messages, extracted, flattenedCount, contextTokensSaved, … }` —
  **persist `extracted` yourself; you are the store.** `--unflatten` restores
  byte-for-byte. No server, no disk, no network. Bad input → stderr + exit 1.

</details>

<details>
<summary><b>Library API — <code>flattenMessages</code> / <code>unflattenMessages</code> in-memory</b></summary>

```ts
import { flattenMessages, unflattenMessages } from 'flatten-mcp';

const { messages, extracted, contextTokensSaved } = flattenMessages(myMessages);
// send `messages` to the API; persist `extracted` yourself — you are the store.
const original = unflattenMessages(messages, extracted);   // byte-for-byte restore
```

- Synchronous, never mutates input (deep-copies first). `flattenRequestBody` /
  `unflattenRequestBody` handle a full `{ system, messages, tools, … }` body.
- Exact token counts (optional, async): `flattenMessagesExact` uses Anthropic's free
  `count_tokens` when `ANTHROPIC_API_KEY` is set — calling the `*Exact` variant is the
  opt-in here (`countExact: false` forces the estimate); the `FLATTEN_COUNT_EXACT`
  variable gates only the MCP server and session CLI.
- **Prompt-caching caveat:** flattening earlier messages changes the cached prefix and
  invalidates `cache_control` breakpoints from that point on — flatten **before**
  establishing a breakpoint, or the cache re-write can cost more than the flatten saves
  in short-lived conversations.

</details>

<details>
<summary><b><code>flatten-mcp-http</code> — the in-memory engine over MCP Streamable HTTP</b></summary>

```bash
npx -y -p flatten-mcp flatten-mcp-http            # POST http://127.0.0.1:8787/mcp
npx -y -p flatten-mcp flatten-mcp-http --port 3000 --host 0.0.0.0
```

- Serves `flatten_messages` / `unflatten_messages` — the same stateless in-memory engine
  as the library, callable from any MCP client or hosted registry inspector. Persist the
  returned `extracted` yourself and feed it back to restore, exactly like the library.
- The three disk tools are **not** exposed over HTTP: they operate on the local Claude
  Code session store, which does not exist wherever a remote client calls from. (On the
  stdio server, `FLATTEN_INMEMORY_TOOLS=1` adds these two tools alongside the disk ones.)
- No auth, permissive CORS, **no outbound network calls** — the tools are pure functions
  over the request's JSON. Binds `127.0.0.1` by default; put your own proxy/auth in front
  before exposing it further. Note the transport cost: the conversation you flatten
  travels to this server and back — inside your own process, prefer the library.

</details>

## FAQ

**Won't Anthropic just build this in?** Claude Code already clears old tool results
automatically near the limit (see the table up top). Flatten is a different contract:
*you* pick the moment, the restore is byte-identical, and the on-disk session you
`/resume` from actually shrinks.

**Will the model fetch a flattened block, or hallucinate around it?** Each marker carries
the id and session, and in practice the model calls `retrieve_flattened` when it needs raw
bytes back. Deterministic recovery is always there regardless: `unflatten_session`
re-inlines everything.

**Does it need Node in my project?** No — it runs through `npx` ephemerally and touches
only Claude Code's files, not your project or toolchain.

**Can a team use it?** It's per-developer (each dev's local session store). Standardize by
committing the `mcpServers` block to your project's `.mcp.json`, or point the team at the
plugin install.

## Compatibility & roadmap

- **Claude Code's session store only, for now** — the paths and JSONL schema are specific
  to it. **WSL2 counts as Linux**: if your Claude Code runs inside WSL2, flatten-mcp runs
  in the same environment and targets those sessions normally. Native Windows is untested.
- The CLI and library above are the first adapter over the shared block logic; porting to
  other agents means abstracting the storage seam — contributions welcome
  ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Configuration

Operates on the project the CLI runs in; pass `project_dir` on any call to target another.

| Env var | Required | Purpose |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | no | Claude config dir whose `projects/` store is read (default `~/.claude`). Same variable Claude Code uses for profiles, so an alternate-profile server targets its own sessions automatically; override per call with `claude_dir`. |
| `FLATTEN_COUNT_EXACT` | no | Set to `1` to count token savings **exactly** via Anthropic's free `count_tokens` — the only outbound call, and it needs `ANTHROPIC_API_KEY` too. Off by default: key presence alone never triggers the request (see Security). |
| `ANTHROPIC_API_KEY` | no | The key for the exact count. Ignored by the MCP server and session CLI unless `FLATTEN_COUNT_EXACT=1`. |
| `FLATTEN_COUNT_MODEL` | no | Model id for the exact count (default `claude-haiku-4-5-20251001`). |
| `FLATTEN_INMEMORY_TOOLS` | no | Set to `1` to also register `flatten_messages`/`unflatten_messages` on the stdio server (see the HTTP section above). Off by default to keep the local tool surface lean. |

## Uninstall

Unflatten anything you want back inline **first** — a flattened session needs its
`<session>.jsonl.bak` for `retrieve_flattened`/`unflatten_session`, and uninstalling does
not remove backups. Then:

```bash
claude mcp remove flatten -s user && rm -f ~/.claude/commands/flatten.md   # terminal install
claude plugin uninstall flatten-mcp                                        # plugin install
```

To reclaim disk for sessions you'll never restore, delete their `.jsonl.bak` files from
`~/.claude/projects/<encoded-project-dir>/`.

## Contributing

Issues and PRs welcome — dev setup, project map, and workflow in
[CONTRIBUTING.md](CONTRIBUTING.md); security reports via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Shaya Shaviv
