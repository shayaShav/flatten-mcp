# self-cleaning-backup

Covers the Claude Code disk adapter ([src/flattener.ts](../../../src/flattener.ts)) after the
artifact restructure: the old multi-file model (`.bak` + `.flat.jsonl` sidecar +
`.preunflatten.bak`, mopped up by a `prune` tool) was replaced by a **single
self-syncing backup**.

## The model under test

One side artifact per session: `<session>.jsonl.bak`, holding the **complete
session, fully inlined** — "the session as if you'd never flattened". The live
`<session>.jsonl` carries the lightweight `[FLATTENED id=…]` markers. They are
duals, maintained together on every flatten:

- `backup = unflatten(live)` — the complete originals
- `live   = flatten(backup)` — the markers

`retrieve_flattened` reads an original straight out of the backup;
`unflatten_session` re-inlines the live file from the backup and then **deletes
the backup**, so a fully restored session leaves zero artifacts behind.

## What the tests assert

| Test | Guarantee |
| --- | --- |
| first flatten writes ONE backup | exactly `<id>.jsonl.bak`; **no** `.flat.jsonl`, **no** `.preunflatten.bak` |
| backup is the pristine original | on the first flatten the backup is the complete, marker-free session |
| dry run | reports the count, writes nothing |
| retrieve content + mirror | both slots resolve straight from the backup |
| retrieve unknown id | throws `not found in backup` |
| unflatten restores + deletes backup | `restoredCount` correct, backup gone → zero artifacts |
| round-trip value-faithful | `unflatten(flatten(x))` deep-equals `x` |
| append-after-flatten survives | unflatten re-inlines (never blind-copies the backup over the live file), so a turn added after the flatten is preserved |
| live re-flatten | the backup stays complete across flattens — every turn's original is still retrievable, and a later unflatten restores all of them |
| base64 image | image tool_result flattens and retrieves back as an image block |
| unflatten with no backup | safe no-op (`skipped`) |

## Run

```
npx vitest run tests/feature/self-cleaning-backup
```
