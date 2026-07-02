# 7 — Trust & funnel batch

One branch covering issues #7–#11 (milestone v2.0.5): make the public surfaces accurate,
the first run survivable, and releases test-gated.

## README (#7)

Restructured to be shorter and funnel-first while adding the previously missing
onboarding steps:

- Security section corrected: npm OIDC trusted publishing with provenance attestations
  and signed tags shipped in v2.0.4 and are now claimed and verifiable
  (`npm audit signatures`) instead of denied.
- Quick start now states the two steps that first runs failed on: restart Claude Code
  (or open a new session, verify with `/mcp`) after registering the server, and the
  `/flatten` → `/resume` reload loop — with the backup guarantee in the same breath as
  the in-place-rewrite warning.
- Pinned-version install is the primary command; `@latest` is the aside.
- A comparison table (`/compact` / automatic tool-result clearing / flatten) answers the
  built-ins objection up front.
- Platform support (macOS · Linux · WSL2, native Windows untested) is in the first
  screenful, with a WSL2 clarification in Compatibility.
- The plugin install path is documented; `.claude-plugin/plugin.json` now registers the
  MCP server via `mcpServers` (previously the plugin shipped only the `/flatten` command,
  without the server it calls). Verified end-to-end: `claude plugin validate`,
  marketplace add, install — the cached plugin carries both the server wiring and the
  command.
- The two CLI sections and the library API are consolidated into one collapsed
  "Beyond Claude Code" section after Security; the prompt-caching caveat is stated with
  its cost implication.
- Badge row: Smithery badge removed, CI tests badge added.
- `package.json` description tightened (npm search text).

## CI (#8)

`test.yml` runs `npm ci && npm run build && npm test` on push to main and on every PR
(Node 18/20/22). `publish.yml` gained a `test` job the `publish` job depends on, so a tag
push cannot publish untested.

## Session CLI fix (#9)

Unquoted `flatten last 5` used to flatten one session, silently dropping the `5`.
Argument handling moved to `src/session-cli-core.ts` (pure, testable — mirrors
`cli-core.ts`): a leading `last <digits>` pair merges into the `"last N"` selector, and
unexpected extra positionals hard-error across all subcommands. Regression tests in
`tests/feature/session-cli/`.

## retrieve_flattened validation (#10)

`session_id` flows into the backup path; `isSafeSessionId` (in `session-store.ts`)
rejects values with path separators or `..` segments before path construction, keeping
reads confined to the session directory as documented.

## Governance (#11)

`SECURITY.md` (private reporting via GitHub Security Advisories, supported versions,
scope), `CHANGELOG.md` (Keep a Changelog, backfilled v1.0.0–v2.0.4), `CONTRIBUTING.md`
(dev setup, project map, issue-first workflow).
