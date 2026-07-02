# Security policy

flatten-mcp rewrites Claude Code session files on the local machine. Treat anything that
could corrupt a session, leak its content, or execute unexpected code as a security issue.

## Reporting a vulnerability

Report privately via GitHub Security Advisories:
<https://github.com/shayaShav/flatten-mcp/security/advisories/new>

Please do not open a public issue for a suspected vulnerability. Reports are acknowledged
within a few days.

## Supported versions

Fixes ship for the latest published release only.

## Scope notes

- Every read and write is confined to the Claude Code session store
  (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/`); each rewrite is written to a backup
  first and applied atomically.
- The only network call in the codebase is Anthropic's `count_tokens` endpoint, active
  only when `ANTHROPIC_API_KEY` is set; the request body is the content being flattened.
- No telemetry, no shell execution, no hooks.
- Releases are published from CI via npm trusted publishing (OIDC) with provenance
  attestations, and release tags are signed. Verify an install with `npm audit signatures`.
