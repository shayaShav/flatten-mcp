# Changelog

All notable changes to flatten-mcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-07-03

### Changed

- **Behavior change**: the exact `count_tokens` call (MCP server and session CLI) now
  requires an explicit `FLATTEN_COUNT_EXACT=1` in addition to `ANTHROPIC_API_KEY` — key
  presence alone no longer triggers a network request. The library's `*Exact` functions
  keep their explicit `countExact` parameter and are unaffected. The request body is now
  documented in the README's Security section. (#12)

### Added

- `flatten-mcp-http`: the in-memory engine (`flatten_messages`/`unflatten_messages`) over
  MCP Streamable HTTP — stateless, localhost by default, no outbound network — so hosted
  registry inspectors and remote MCP clients can call the engine interactively. (#12)
- `FLATTEN_INMEMORY_TOOLS=1` registers the same two in-memory tools on the stdio server
  (off by default to keep the local tool surface lean). (#12)
- Companion packages `flatten-mcp-session`, `flatten-mcp-cli`, and `flatten-mcp-http`
  (in `packages/`, published separately): one-line delegates that claim the bin-name npm
  namespace so `npx <bin>` works directly — including the commands printed in pre-2.1
  README copies — and the names cannot be squatted. Enabled by new subpath exports
  `flatten-mcp/session-cli`, `flatten-mcp/cli`, `flatten-mcp/http`. (#12)

### Fixed

- README invoked the secondary bins as `npx flatten-mcp-session` / `npx flatten-mcp-cli`,
  which fails on a machine without the package installed (no npm packages by those names
  exist — the bins ship inside `flatten-mcp`). All examples now use
  `npx -y -p flatten-mcp <bin>`. (#12)

## [2.0.5] - 2026-07-03

### Added

- CI test workflow (Node 18/20/22) on every push and PR; publishing is now gated on the
  test suite, so a tag push cannot ship an untested build. (#8)
- The Claude Code plugin now registers the MCP server (`mcpServers` was missing from
  `.claude-plugin/plugin.json` — the plugin previously installed the `/flatten` command
  without the server it calls). (#7)
- `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md`, and this
  changelog. (#11)

### Fixed

- Session CLI: unquoted `flatten last 5` silently flattened only one session — a leading
  `last <digits>` pair now merges into the `"last N"` selector, and unexpected extra
  positionals are a hard usage error across all subcommands. (#9)
- MCP server: `retrieve_flattened` validates `session_id` before building the backup
  path, so values carrying path separators or `..` segments can no longer point outside
  the session directory. (#10)

### Changed

- README restructured: shorter and funnel-first — corrected security section (npm
  provenance and signed tags shipped in v2.0.4), pinned-version install as the primary
  command, the restart and `/flatten` -> `/resume` steps stated in Quick start, a
  compact comparison table, platform note in the first screenful with a WSL2
  clarification, plugin install path documented, CLI/library material consolidated. (#7)

## [2.0.4] - 2026-07-03

### Changed

- Publishing moved to CI: npm OIDC trusted publishing with provenance attestations,
  triggered by signed release tags. No local `npm publish`, no npm token anywhere. (#4)

## [2.0.3] - 2026-07-02

### Fixed

- Docs-only: final corrected demo GIF.

## [2.0.2] - 2026-07-02

### Fixed

- Docs-only: corrected demo GIF.

## [2.0.1] - 2026-07-02

Version 2.0.0 was never tagged or published; its changes first shipped here.

### Added

- Live-session flatten: bare `flatten_session` targets the current session via
  `CLAUDE_CODE_SESSION_ID`.
- `flatten-mcp-cli`: stdin/stdout adapter that flattens a raw Messages API `messages[]`
  array — no server, no disk, no network.
- `flatten-mcp-session`: terminal CLI driving the same disk engine as the MCP server,
  with zero LLM tokens.
- In-memory library API (`flattenMessages` / `unflattenMessages`) over a shared core.
- Demo GIF with measured numbers (340,071 -> 132,800 tokens).

### Changed

- **Breaking**: leaner tool surface — the separate prune tool is gone; a single
  self-cleaning backup (`<session>.jsonl.bak`) holds the complete inlined session and is
  removed by a full `unflatten_session`.
- README rewritten around the measured demo.

## [1.1.0] - 2026-06-20

### Added

- Alternate Claude profiles: the session base dir honors `CLAUDE_CONFIG_DIR`, and every
  tool accepts a per-call `claude_dir` override (e.g. `~/.claude-2`).

## [1.0.3] - 2026-06-13

### Changed

- Docs-only: badge row.

## [1.0.2] - 2026-06-13

### Added

- Project logo, wired into the registry and bundle manifests.
- Absolute-path guard for `project_dir`; `count_tokens` payload disclosure; POSIX note;
  MCPB manifest.

## [1.0.1] - 2026-06-13

### Added

- MCP Registry and Glama listings; Claude Code plugin packaging.

## [1.0.0] - 2026-06-13

### Added

- Initial release: `flatten_session`, `retrieve_flattened`, and backup-based restore
  over the Claude Code session store — every prompt verbatim, bulky tool output moved
  to a sidecar, fully reversible.

[Unreleased]: https://github.com/shayaShav/flatten-mcp/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/shayaShav/flatten-mcp/compare/v2.0.5...v2.1.0
[2.0.5]: https://github.com/shayaShav/flatten-mcp/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/shayaShav/flatten-mcp/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/shayaShav/flatten-mcp/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/shayaShav/flatten-mcp/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/shayaShav/flatten-mcp/compare/v1.1.0...v2.0.1
[1.1.0]: https://github.com/shayaShav/flatten-mcp/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/shayaShav/flatten-mcp/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/shayaShav/flatten-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/shayaShav/flatten-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/shayaShav/flatten-mcp/releases/tag/v1.0.0
