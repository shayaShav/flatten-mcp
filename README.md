<p align="center">
    <img src="https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/assets/logo.png" alt="flatten-mcp logo" width="160">
</p>

# flatten-mcp

> Cut the tokens every Claude Code session carries — real money on the API, more
> headroom before the limit on a subscription — **without** compacting your history
> into a lossy summary or losing a single line.

<p align="left">
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/flatten-mcp.svg"></a>
  <a href="https://www.npmjs.com/package/flatten-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/flatten-mcp.svg"></a>
  <a href="https://github.com/shayaShav/flatten-mcp/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="https://modelcontextprotocol.io"><img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-6E56CF.svg"></a>
  <a href="https://docs.claude.com/en/docs/claude-code"><img alt="Built for Claude Code" src="https://img.shields.io/badge/built%20for-Claude%20Code-D97757.svg"></a>
  <a href="https://smithery.ai/server/@shaya-shaviv/flatten-mcp"><img alt="Smithery calls" src="https://smithery.ai/badge/@shaya-shaviv/flatten-mcp"></a>
</p>

<p align="center"><b>340,071 → 132,800 tokens — a 61% lighter session, every line of history intact.</b></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shayaShav/flatten-mcp/main/assets/flatten-demo.gif" alt="Demo: a 340,071-token Claude Code session is flattened, /resume'd, and comes back 61% lighter at 132,800 tokens — history verbatim" width="820">
</p>

Most of a long session's tokens are **bulk the model already distilled into prose** — the
2 MB log it boiled down to one line, the screenshot it described, the five files it
summarized. That raw source has done its job. **flatten-mcp** sets it aside in a local backup
and leaves a small `[FLATTENED …]` marker, so every resumed turn carries far fewer tokens.
Your prompts and the exact timeline stay **verbatim** — nothing is rewritten, nothing is
summarized away, and any block is one call (or one `unflatten`) from coming back.

**Who it's for:** heavy Claude Code users — large file reads, long command logs, or
screenshot-heavy (Playwright) sessions — who want to pay for fewer tokens without losing
their history.

---

## Quick start

flatten-mcp runs through `npx` — **no global install, nothing added to your project**, and
every read/write stays inside Claude Code's own session store under
`~/.claude/projects/`. Zero network calls by default. (Needs Node ≥ 18, which Claude Code
already runs on.)

One command — installs from [npm](https://www.npmjs.com/package/flatten-mcp) and registers it user-wide:

```bash
claude mcp add flatten -s user -- npx -y flatten-mcp@latest
```

Prefer to vet upgrades yourself? Pin an exact version: `npx -y flatten-mcp@2.0.2`.

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

## Usage

> [!NOTE]
> Flattening rewrites the session file in place. The window you're in keeps the pre-flatten copy in memory until you reload it, so **`/flatten`, then `/resume`** (switch to another session and back) to load the lighter copy.

1. In the session you want to shrink, type `/flatten` — or ask:
   > "Flatten this session."

   Bare `/flatten` flattens the **current** session — the server identifies it from `CLAUDE_CODE_SESSION_ID`. Pass a UUID (`/flatten <session-id>`) to target a different session.
2. **`/resume` the session** (switch to another session and back) and send a prompt. Until you do, this window still holds the full version; once reloaded, you'll see the token count drop when Claude next outputs text.

To preview without touching anything, ask for a **dry run** first. To undo, ask to **unflatten** the session — every original block is restored to its exact original value.

> [!TIP]
> Flattening needs no model intelligence — it's pure file surgery, so a fast, inexpensive model (`/model haiku`) flattens just as well as a frontier one. Run `/flatten` from a separate window and your working session never even carries flatten-mcp's tool schemas.

## What you'll actually save

The reduction depends entirely on what the session did — it's the bulk you remove, not a fixed percentage:

- **Read-heavy sessions** (large files, long logs, or screenshots in context) — the demo above went **340,071 → 132,800 tokens, a 61% cut** (the in-terminal report in the recording shows the tool's conservative local estimate; the status bar shows the real measured drop). The more of your context is ingested bulk, the bigger the cut; sessions dominated by base64 screenshots can go higher.
- **Prose-heavy sessions** (little external data ingested) — savings are small. There's simply not much bulk to move.

**When to reach for it.** A common point is around **200k** tokens; for critical sessions where you want the model at its sharpest, flattening around **250k–400k** is where the most dramatic cuts show up. And it's repeatable: as the session keeps growing, run it again — a re-flatten only touches the bulk that arrived since the last one. Flatten the same way you wouldn't compact mid-way through a large reading task — though nothing is ever lost, so flattening everything and cherry-picking the few blocks you still need is a perfectly legitimate strategy.

**Doesn't an MCP server add its own context cost?** Yes, and here it's small: the three tool
schemas measure **~1,200 tokens per turn** while flatten-mcp is connected. A single flatten
of a read-heavy session removes far more than that from **every** later turn — 207k in the
demo — so it pays back the schema cost on the first flatten and many times over after. Want
zero overhead in your main session? Run `/flatten` from a separate window (see the tip above).

---

## Why flatten instead of compact?

The standard answer to a full context window is **compaction**: the model reads the whole conversation and rewrites it into a shorter summary. That summary is lossy by construction — an *interpretation* of your history, and interpretations drift, smooth over the awkward parts, and quietly drop the detail you didn't know you'd need. But the history is exactly what's worth keeping verbatim: the words you typed at 2 a.m., the precise order of events, the dead ends and the decisions. A fuzzy, half-formed prompt carries more raw truth about your intent than any tidy paragraph written *about* it after the fact — and preserving it untouched is the foundation of trust in a coding agent.

**Flattening is the opposite move.** It changes *nothing* about what was said. In most sessions the model reads a lot — large files, long logs, multiple sources — and keeps every byte in context, even though it has nearly always already **written the conclusion down in plain prose**: the one line that mattered in a 2 MB log, the finding distilled from five files, the running tally of open tasks. The raw source has done its job. Flattening lifts those already-summarized blocks out and swaps each for a lightweight reference ID — so starting cold from a flattened session is usually smooth sailing, and on the rare occasion the raw bytes *are* needed, they're one `retrieve_flattened` call away.

```
What sits in the context window:

   USER         "fix the crash"
   ASSISTANT    reading the logs…
   TOOL_RESULT  ▓▓▓ 2 MB log dump ▓▓▓        ← bulk; already summarized in prose below
   ASSISTANT    "the OOM is at line 88,402 — the fix is …"

After flatten — same words, only the bulk set aside:

   USER         "fix the crash"
   ASSISTANT    reading the logs…
   TOOL_RESULT  [FLATTENED id=… → backup]    ← one marker; fetch the full dump on demand
   ASSISTANT    "the OOM is at line 88,402 — the fix is …"
```

## Tools

| Tool | What it does |
| --- | --- |
| `flatten_session` | Move bulky tool results into a backup copy, leaving `[FLATTENED …]` markers. Crash-safe and reversible. With no argument, flattens the current live session. Supports `dry_run`, `min_size`, and `include_tool_use_result`. |
| `retrieve_flattened` | Fetch one original block back by its id — returns the original text, or re-renders a flattened screenshot as a real image. |
| `unflatten_session` | Reverse a flatten completely: re-inline every block from the backup, then delete the backup so a fully restored session leaves nothing behind. |

When a session is flattened, the model sees compact markers like this in place of the original output:

```
[FLATTENED id=toolu_01AbC… tool=Read file_path=/src/server.ts | text 48213B/612L | session=2f9c… | retrieve_flattened(id,session) for raw content]
```

Everything the model needs to fetch the original — the id and the session — is right there in the marker.

## CLI — flatten a Claude Code session from the terminal (no LLM turn)

Want to flatten the *same Claude Code sessions* the MCP tools operate on, but from a shell —
a script, a cron job, or another window — without an LLM turn and **without spending any
tokens**? `flatten-mcp-session` drives the exact same on-disk engine as the MCP server, so its
behavior matches the `flatten_session` / `unflatten_session` / `retrieve_flattened` tools.
(This is the disk counterpart to `flatten-mcp-cli` below, which never touches your session
store.)

```bash
# Flatten the most-recent session in this project (or pass a UUID / "last" / "current"):
npx flatten-mcp-session flatten
npx flatten-mcp-session flatten <session> --dry-run          # preview, write nothing
npx flatten-mcp-session flatten <session> --min-size 2000

# List this project's sessions (newest first), reverse a flatten, or fetch one block back:
npx flatten-mcp-session list
npx flatten-mcp-session unflatten <session>
npx flatten-mcp-session retrieve  <session> <tool_use_id> --out shot.png
```

- `<session>` accepts a UUID, `last`, `last N`, `current`, or a keyword — the same grammar as
  the MCP tool. `flatten` defaults to `current` (the most-recent session when run outside
  Claude Code).
- Shared options: `--project-dir <abs>` (default: the directory you run in), `--claude-dir
  <dir>` (default: `$CLAUDE_CONFIG_DIR` or `~/.claude`), and `--json` for machine output.
  `flatten` also takes `--no-tool-use-result` to leave the disk-only `toolUseResult` mirror
  untouched (the `include_tool_use_result: false` equivalent).
- `retrieve` prints text to stdout (header on stderr, so pipes stay clean) and writes image
  blocks to a file — a terminal can't render base64.

Flattening needs no model intelligence — it's pure file surgery — so the terminal path costs
nothing and is ideal for automation. After a real flatten, `/resume` the session in Claude
Code (switch away and back) to load the lighter copy.

## CLI — flatten a Messages API conversation from any language

Not in Claude Code? `flatten-mcp-cli` runs the same engine over **stdin/stdout**, so a caller
in any language (Python, Go, Ruby, shell) can flatten a raw Anthropic Messages API
`messages[]` array without importing the JS library — no server, no MCP, no disk, no network.

```bash
# Flatten: stdin is a messages[] array, or {"messages":[...],"minSize"?:N}
echo '[{"role":"user","content":"hi"}]' | npx flatten-mcp-cli --flatten
npx flatten-mcp-cli --flatten --min-size 2000 < body.json > flattened.json

# Unflatten: stdin is the --flatten output ({messages, extracted}); restored byte-for-byte
npx flatten-mcp-cli --unflatten < flattened.json > restored.json
```

- `--flatten` prints `{ messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved, contextTokensExact }` (`contextTokensExact` is always `false` here — the CLI never makes a network call). **Persist `extracted` yourself — you are the store.**
- `--unflatten` prints `{ messages }`, restored byte-for-byte from the `--flatten` output (extra keys ignored).
- `--min-size N` overrides the 1000-byte default (the flag wins over an inline `minSize`).
- Bad usage or bad JSON → a message on stderr and exit code 1.

## Library API — flatten a raw Messages API conversation in-memory

Calling the Anthropic Messages API (`POST /v1/messages`) directly from Node, with no Claude
Code and no session file? Import the flatten engine and run it on the
`messages[]` array already in your process — no server, no HTTP, no MCP, no disk:

```ts
import { flattenMessages, unflattenMessages } from 'flatten-mcp';

// Before sending the request:
const { messages, extracted, flattenedCount, contextTokensSaved } = flattenMessages(myMessages);
// → `messages` is a deep-copied, flattened body; send it to the API.
// → persist `extracted` yourself — you are the store.

// Later, to reconstruct the original conversation byte-for-byte:
const original = unflattenMessages(messages, extracted);
```

Bulky `tool_result` blocks (large text output and base64 image/screenshot blocks)
over `minSize` (default 1000 bytes) are swapped for a compact `[FLATTENED id=…]`
marker; every other block is kept verbatim. Your input is **never mutated** —
flattening deep-copies first.

- `flattenMessages(messages, { minSize? })` → `{ messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved, contextTokensExact }`. Synchronous; `contextTokensSaved` is a local estimate and `contextTokensExact` is `false` (no network call).
- `unflattenMessages(messages, extracted)` → restored `messages[]` (last entry wins per id; unmatched markers left in place).
- **Whole request body?** `flattenRequestBody(body, { minSize? })` and `unflattenRequestBody(body, extracted)` take the full `{ system, messages, tools, … }` — only `messages` is transformed, every other field passes through untouched on a new object.
- **Exact token counts** (optional, async): `flattenMessagesExact` / `flattenRequestBodyExact` report `contextTokensSaved` exactly via Anthropic's free `count_tokens` endpoint when `ANTHROPIC_API_KEY` is set (`contextTokensExact: true`), and fall back to the local estimate otherwise. Pass `{ countExact: false }` to force the estimate. This is the **only** code path that makes a network call.
- **The caller is the store.** There is no sidecar — persist `extracted` and feed it back to restore.
- **Prompt-caching caveat.** Flattening earlier messages changes the cached prefix and invalidates `cache_control` breakpoints from that point. Flatten **before** establishing a cache breakpoint.

The CLI and the library are the *no-storage adapter* of the pluggable backend; the disk MCP
tools are the *Claude Code adapter* over the same block logic.

## How it works

- **One backup, not deletion.** flatten keeps a single artifact next to the session: `<session>.jsonl.bak`, holding the **complete session, fully inlined** — every original block in place, as if you'd never flattened. The live `<session>.jsonl` carries the lightweight markers. The two are kept in lockstep on every run (`backup = unflatten(live)`, `live = flatten(backup)`).
- **Crash-safe.** The complete originals are written to the backup *before* the bulk is removed from the session, each via an atomic temp-file-and-`rename`, so an interrupted run can never leave a half-written, irreplaceable session file — the live markers always resolve against the backup.
- **Self-cleaning.** `unflatten_session` re-inlines the live file from the backup and then **deletes the backup**, so a fully restored session leaves zero artifacts behind. There is no sidecar and no pre-unflatten snapshot to mop up.
- **Live re-flatten.** Re-running as the session grows only touches newly-arrived bulk; the backup is rebuilt each time to stay the complete inlined session, so every block — old or new — stays retrievable, and content added *after* a flatten is never lost on restore.
- **Lossless & reversible.** Text and base64 images are stored exactly as they appeared, so `unflatten_session` restores each flattened block to its exact original value (byte-identical for Claude Code's canonical JSON). Your prompts and untouched lines were never altered to begin with.
- **Disk vs. context tokens.** Claude Code stores each tool result twice on disk (once in the API message, once in a `toolUseResult` mirror) and only one copy is ever sent to the model. flatten reports both `diskBytesSaved` (affects `--resume` parse speed) and `contextTokensSaved` out of `contextTokensTotal` (the number that actually matters for the context window and compaction) — they differ a lot, and the tool is explicit about which is which.

See [docs/ARCHITECTURE.md](https://github.com/shayaShav/flatten-mcp/blob/main/docs/ARCHITECTURE.md) for the session JSONL format, the backup model, and the marker protocol.

### Validate the claims yourself

Every number flatten reports can be checked end to end in a couple of minutes:

1. Pick a meaty session — or make one: have Claude read a few large files.
2. Ask for a **dry run** — *"dry-run flatten this session"* — and read the report: `flattenedCount`, `contextTokensSaved` of `contextTokensTotal`, `diskBytesSaved`. Nothing has been written yet.
3. Run `/flatten` for real, then `/resume` the session and send any prompt — the context indicator drops by roughly the reported amount (exactly, when `ANTHROPIC_API_KEY` is set).
4. Check reversibility: while flattened, the `<session>.jsonl.bak` backup is the complete original — diff it against a copy of your pre-flatten session if you kept one. Then ask to **unflatten**: every block is restored to its exact original value (byte-identical for Claude Code's canonical JSON), and the backup is removed once the restore is clean.

## Security & verification

The server is a handful of small TypeScript files; the shared engine, the library export, and
the `flatten-mcp-cli` and `flatten-mcp-session` bins add a few more — and the whole thing
has just two runtime dependencies ([`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk),
[`zod`](https://www.npmjs.com/package/zod)). It's a quick read.

- **File access.** Every read and write is confined to Claude Code's session store, `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded-project-dir>/`. Rewriting session `.jsonl` files there is the tool's entire job, and each rewrite is backed up once and applied atomically (see [How it works](#how-it-works)). Nothing else on disk is ever touched — the one exception is `flatten-mcp-session retrieve`, which writes a retrieved image to the output path you pass it (a terminal can't render base64), and only then.
- **Network.** Zero network calls by default. When `ANTHROPIC_API_KEY` is set, exactly one endpoint is contacted: `POST https://api.anthropic.com/v1/messages/count_tokens` (free) to report exact token savings. The request body is the content being flattened — the same tool output and screenshots Anthropic already processed in the session — sent only to Anthropic for counting. The key is read from the environment, sent only as the auth header, and never stored or logged. There is no other URL in the codebase.
- **No telemetry, no shell, no hooks.** No analytics, no usage tracking, no phone-home. The server spawns no processes, executes no shell commands, installs no hooks, and needs no permission bypasses.
- **Safe defaults.** Every rewrite is backed up first and applied atomically — an interrupted run can't corrupt the session — and a **dry run** previews exactly what `flatten` would change before anything is written.

**Verifying a build before you trust it.** Pin an exact version (`npx -y flatten-mcp@2.0.2`)
rather than `@latest`, inspect the published tarball (`npm view flatten-mcp@2.0.2 dist.tarball`,
or `npm pack` and read it — it's `dist/` plus this README and the license), and the committed
`package-lock.json` pins the full dependency tree. The source is small enough to audit in one
sitting. (Cryptographic publish provenance and signed tags aren't wired up yet — for now,
pin-and-audit is the trust path.)

## FAQ

**Why not just use `/compact`?** Compaction rewrites your history into a shorter, lossy
summary — it decides what to forget. Flatten keeps every prompt and event verbatim and only
sets aside the bulky tool output the model already summarized; it's reversible, `/compact`
isn't.

**Won't Anthropic just build this in?** Pulling already-summarized raw bytes out of context
is a sound practice regardless of how compaction evolves. Even if Claude Code grows its own
version, a *lossless, reversible* move is a different guarantee than a summary.

**Will the model actually fetch a flattened block, or hallucinate around it?** Each marker
carries the `id` and `session`, and in practice the model calls `retrieve_flattened` when it
needs the raw bytes back (verified on Claude Code's current session format and the standard
flow). And it's deterministic regardless: `unflatten_session` re-inlines everything
byte-for-byte whenever you want the full session back.

**Does it need a JS/Node toolchain in my environment?** No. It runs through `npx`
ephemerally and operates on Claude Code's files — it adds nothing to your project and doesn't
touch your Python/Conda/whatever environment.

**Can a team use it?** It's per-developer (it works on each dev's local session store).
Standardize it across a team by committing the `mcpServers` config to your project's
`.mcp.json` and shipping the `/flatten` command with your dotfiles.

## Compatibility & roadmap

- **Claude Code only, for now.** flatten-mcp reads Claude Code's session store at `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded-project-dir>/*.jsonl`. It has been tested against Claude Code exclusively; the paths and the JSONL schema are specific to it and **will not work** for other agents or LLM CLIs as-is. Path handling is POSIX (macOS/Linux); Windows is untested.
- **Shipped — a no-storage adapter.** The [CLI](#cli--flatten-a-messages-api-conversation-from-any-language) and [Library API](#library-api--flatten-a-raw-messages-api-conversation-in-memory) (`flattenMessages` / `unflattenMessages`) flatten an in-memory `messages[]` array for raw Messages API callers, with no session file. It's the first adapter over the shared block logic.
- **Planned — more session backends.** Porting to other agents means abstracting the storage location and the on-disk message format behind the same small adapter seam. Contributions welcome.

## Configuration

By default the server operates on **the project the CLI runs in** (its current working directory). Pass `project_dir` explicitly on any call to target a different project.

**Multiple Claude profiles.** Sessions are read from `$CLAUDE_CONFIG_DIR/projects/` when that env var is set, else `~/.claude/projects/`. Because Claude Code itself uses `CLAUDE_CONFIG_DIR` to pick a profile (e.g. a `claude-2` launcher that exports `CLAUDE_CONFIG_DIR=~/.claude-2`), a flatten-mcp server spawned inside an alternate profile **automatically** targets that profile's sessions. To reach another profile's sessions from a different one, pass `claude_dir` on any call — the absolute path (or `~/...`) to that profile's config dir, e.g. `claude_dir: "~/.claude-2"`.

| Env var | Required | Purpose |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | no | Claude config dir whose `projects/` store is read. Defaults to `~/.claude`. Honors the same variable Claude Code uses for profile selection, so an alternate-profile session targets its own sessions with no extra config. Override per call with the `claude_dir` argument. |
| `ANTHROPIC_API_KEY` | no | If set, token savings are counted **exactly** via Anthropic's free `count_tokens` endpoint instead of estimated locally. |
| `FLATTEN_COUNT_MODEL` | no | Model id used for the exact token count (default: `claude-haiku-4-5-20251001`). |

## Uninstall

```bash
claude mcp remove flatten -s user       # unregister the server
rm -f ~/.claude/commands/flatten.md     # remove the /flatten command, if installed
```

A `<session>.jsonl.bak` backup lives next to each flattened session and is **not** removed by uninstalling — only by `unflatten_session`, which restores the bulk inline and then deletes it. To reclaim disk for sessions you won't restore, delete the `.jsonl.bak` files manually from `~/.claude/projects/<encoded-project-dir>/`. Mind that a flattened session needs its backup for `retrieve_flattened` / `unflatten_session` — unflatten first if you want the bulk back inline.

## Contributing

Issues and PRs are welcome. To develop locally:

```bash
npm install
npm run dev        # tsc --watch
npm run build      # one-off compile to dist/
npm test           # vitest
```

## License

[MIT](LICENSE) © Shaya Shaviv
