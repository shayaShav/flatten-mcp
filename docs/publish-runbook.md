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

## 5. Glama — claim the listing

`glama.json` at the repo root with `"maintainers": ["shayaShav"]` is the claim mechanism
(Glama blog, 2025-07-08; schema requires only `maintainers`). After pushing to `main`,
check the listing at <https://glama.ai/mcp/servers> (search "flatten-mcp"). The blog does not
document a manual re-index trigger; if the claim does not appear, the Claude-in-Chrome launch
task covers contacting/submitting via Glama's site.

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
  `smithery mcp publish ./flatten-mcp.mcpb -n shayaShav/flatten-mcp`.

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
