# Publish runbook — MCP Registry, Glama, Claude Code plugin

Manual steps that need interactive auth (GitHub device flow, npm login, web forms).
Every command below was verified against the official docs on 2026-06-13:

- MCP Registry quickstart: <https://modelcontextprotocol.io/registry/quickstart>
- server.json schema: <https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json>
- Glama: <https://glama.ai/blog/2025-07-08-what-is-glamajson> + <https://glama.ai/mcp/schemas/server.json>
- Claude Code plugins: <https://code.claude.com/docs/en/plugins> (section "Submit your plugin to the community marketplace")

---

## 0. Pre-flight: commit and push the new files

The registry, Glama, and plugin installs all read from GitHub `main`. Commit and push:
`server.json`, `glama.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `docs/publish-runbook.md`.

## 1. MCP Registry — publish `flatten-mcp@1.0.1` to npm first

The registry verifies npm package ownership by reading an `mcpName` field from the package
published **on npm** ("The MCP Registry verifies that a server's underlying package matches its
metadata. For npm packages, this requires adding an `mcpName` property to `package.json`" — registry
quickstart, Step 1). `flatten-mcp@1.0.0` on npm has **no** `mcpName`, so the registry can only
validate against `1.0.1`.

Already done locally (2026-06-13): `package.json` carries
`"mcpName": "io.github.shayaShav/flatten-mcp"` and `"version": "1.0.1"`; both version fields in
`server.json` are synced to `1.0.1`, and `server.json`'s `name` exactly matches `mcpName`.

Remaining — one command:

```bash
npm publish        # the prepublishOnly script rebuilds dist/
```

Sanity check afterwards:
`curl -s https://registry.npmjs.org/flatten-mcp/1.0.1 | jq .mcpName` → `"io.github.shayaShav/flatten-mcp"`.

## 2. MCP Registry — install `mcp-publisher`

Either (both verified from the quickstart, Step 3):

```bash
brew install mcp-publisher
```

or the pre-built binary:

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Sanity check: `mcp-publisher --help`.

## 3. MCP Registry — login (GitHub device flow) and publish

From the repo root (where `server.json` lives):

```bash
mcp-publisher login github     # prints a code; enter it at https://github.com/login/device
mcp-publisher publish
```

GitHub auth requires the server name to start with `io.github.shayaShav/` — it does.

## 4. MCP Registry — verify the listing

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.shayaShav/flatten-mcp"
```

Expect `{"servers":[{ ... "name":"io.github.shayaShav/flatten-mcp" ... }]}`.

## 5. Glama — claim the listing and ship a Dockerfile (build + release)

Two layers, both required for the server to appear in Glama search results.

**Claim.** `glama.json` at the repo root with `"maintainers": ["shayaShav"]` is the claim
mechanism (Glama blog, 2025-07-08; schema requires only `maintainers`). There is **no separate
"Claim" button**: sign in at <https://glama.ai> via GitHub OAuth as `shayaShav` (already-granted
app → silent, no Authorize click), then open the listing — an **Admin** tab (Profile /
Analytics / Repository / Dockerfile) appears automatically because the login matches
`maintainers`. That admin access *is* the claimed/owner state. Live listing:
<https://glama.ai/mcp/servers/shayaShav/flatten-mcp> (non-`@` path).

**Dockerfile (verified 2026-06-15).** Glama does **not** accept a pasted Dockerfile — the admin
**Dockerfile** tab (`.../admin/dockerfile`) is a config form that *generates* one and wraps the
stdio server in `mcp-proxy`. The generated image clones the repo at the head commit and
auto-detects the env-var schema (`ANTHROPIC_API_KEY`, `FLATTEN_COUNT_MODEL`). Only two fields
need filling for this server:

- **Build steps**: `["npm install", "npm run build"]`
- **CMD arguments**: `["node", "dist/index.js"]` → generated `CMD ["mcp-proxy","--","node","dist/index.js"]`
- **Placeholder parameters**: leave `{}` — the server boots with no credentials
  (`ANTHROPIC_API_KEY` is optional). Base image `debian:trixie-slim`, Node 26 default — both fine.

Then **Build** (runs a test build, boots the server, enumerates tools; ~40s) → on success
**Create Release**. The release **Version** defaults to `1.0.0` — set it to match the npm version
(shipped `1.0.3`). After release the Overview flips from "This server cannot be installed" to a
live **Install Server** + **Try in Browser**; the `quality` score recomputes asynchronously.
**Re-run Build + Create Release on every new version** so Glama rebuilds at the new commit.

## 6. Claude Code plugin — validate locally, then submit

Validate (the review pipeline runs the same check):

```bash
claude plugin validate .
```

Local smoke test:

```bash
claude --plugin-dir .
# then inside the session:  /flatten-mcp:flatten latest   and check /plugin → Installed → MCP servers
```

Submit to Anthropic's **community marketplace** (verified from "Submit your plugin to the
community marketplace", code.claude.com/docs/en/plugins):

- **Console form** (works for individual authors — no Team/Enterprise org needed):
  <https://platform.claude.com/plugins/submit>
- claude.ai form (requires a Team/Enterprise org with directory management access):
  <https://claude.ai/admin-settings/directory/submissions/plugins/new>

After approval the plugin is pinned to a commit SHA in the
[`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community)
catalog (CI bumps the pin as you push new commits; the public catalog syncs nightly). Check
installability by searching for `flatten-mcp` in
<https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json>.
Users then run `/plugin marketplace add anthropics/claude-plugins-community` and
`/plugin install flatten-mcp@claude-community`.

Direct install channel (live immediately after push, no review — via this repo's own
`.claude-plugin/marketplace.json`):

```text
/plugin marketplace add shayaShav/flatten-mcp
/plugin install flatten-mcp@flatten-mcp
```

## 7. Release discipline going forward

- `plugin.json` pins `"version": "1.0.1"` — plugin users only receive updates when this field
  is bumped (docs: Version management). Bump it together with the npm version on every release.
- `server.json` carries the exact npm version (ranges and `latest` are rejected by the registry
  schema) — publish a new `server.json` via `mcp-publisher publish` on every npm release.
- `src/index.ts` hardcodes the server version in the `McpServer` constructor, and `manifest.json`
  (the MCPB bundle manifest, used for the Smithery stdio release) pins it too — bump both with
  the npm version, then rebuild and republish the bundle:
  `smithery mcp publish ./flatten-mcp.mcpb -n shaya-shaviv/flatten-mcp`
  (Smithery namespace is `shaya-shaviv` — dash, NOT `shayaShav`; see CLAUDE.md accounts table
  for the full staging + `mcpb pack` + `SMITHERY_CONFIG_PATH` flow this line abbreviates).
  `manifest.json` declares `"icon": "assets/logo.png"` (a bundle-relative path per the MCPB
  spec), so when staging the bundle contents (dist/ + package files), copy `assets/logo.png`
  into the staging dir as well — otherwise the bundle ships a dangling icon reference.
- **Pending for the next release (deferred 2026-06-15):** run `npm audit fix` to clear 7
  transitive advisories (2 moderate, 5 high) under `@modelcontextprotocol/sdk` — all live in the
  SDK's *optional* HTTP/SSE transport (Express + Hono), unreachable from this stdio server, so
  deferred, not urgent. The fix is non-breaking (patch/minor bumps within existing ranges;
  `--force` is unnecessary) and also resyncs the drifted `package-lock.json` (`version` is stuck
  at `1.0.1` while `package.json` is `1.0.3`). After it: `npm run build` (expect zero errors) and
  `npm audit` (expect 0). Caveat: this only cleans our repo/Docker build + committed lockfile —
  a downstream `npm install flatten-mcp` still resolves transitive versions per the SDK's ranges.

## Plugin-channel tool names — RESOLVED (2026-06-13)

`commands/flatten.md` now whitelists **both** naming schemes in `allowed-tools`:

- `mcp__flatten__*` — server registered directly (`claude mcp add flatten ...`, or a project
  `.mcp.json` with server key `flatten`).
- `mcp__plugin_flatten-mcp_flatten__*` — server loaded from the plugin. Evidence for the scheme:
  a plugin-provided server registers as `plugin:<plugin>:<server>` (`claude --plugin-dir <dir> mcp list`
  showed `plugin:flatten-mcp:<server> - ✔ Connected`), and live tool names for an installed plugin
  follow `mcp__plugin_<plugin>_<server>__<tool>` with hyphens preserved (observed on this machine:
  `mcp__plugin_playwright_playwright__browser_click`; hyphen preservation:
  `mcp__brave-search__brave_web_search`). The exact string could not be captured end-to-end in a
  headless run (deferred plugin tools don't surface in `-p` mode); if the derived prefix ever
  mismatches, the only effect is a permission prompt instead of auto-allow — the command still works.
