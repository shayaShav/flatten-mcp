# 4 — npm provenance via OIDC trusted publishing

GitHub issue: [#4](https://github.com/shayaShav/flatten-mcp/issues/4)

## What it does

Releases of `flatten-mcp` are published to npm by GitHub Actions
(`.github/workflows/publish.yml`) instead of from a maintainer machine. The workflow
authenticates through npm's OIDC trusted publishing: npm validates the workflow's
short-lived identity token against the Trusted Publisher configured for the package,
so no npm token is stored in the repository, in CI secrets, or anywhere else.

Because the publish happens via trusted publishing from a public repository, npm
automatically generates and uploads provenance attestations for every release —
cryptographic proof of the exact repository, commit, and workflow run that built the
published tarball.

## How a release publishes

1. The release PR (from a `release/<x.y.z>` branch) is merged to `main`.
2. The maintainer pushes an SSH-signed tag `v<x.y.z>` pointing at the version-bump
   commit. The tag push triggers the workflow.
3. The workflow checks out the tagged commit, asserts the runner's npm meets the
   trusted-publishing floor (>= 11.5.1), installs with `npm ci`, builds, verifies the
   tag equals `v` + `package.json` version, and runs `npm publish`. Provenance needs
   no flag — it is generated automatically under trusted publishing.
4. A `workflow_dispatch` trigger exists as a manual fallback; the tag/version guard
   only applies to tag-triggered runs.

The workflow holds `id-token: write` (required for OIDC) and read-only `contents`
permissions, runs with dependency caching disabled for release hygiene, and a
`concurrency` group prevents overlapping publishes.

## How to verify a release

- The npm package page shows a provenance section for the version.
- `npm audit signatures` in a project depending on `flatten-mcp` reports the
  package's attestations as valid.
- `curl -s https://registry.npmjs.org/flatten-mcp/<version> | jq .dist.attestations`
  returns the attestations descriptor.

## Notes

- Tags from v2.0.3 and earlier predate this workflow and are unsigned; they were
  published from a maintainer machine without provenance.
- The Trusted Publisher binding (owner `shayaShav`, repository `flatten-mcp`,
  workflow `publish.yml`, allowed action `npm publish`) is configured in the npm
  package settings, not in this repository.
