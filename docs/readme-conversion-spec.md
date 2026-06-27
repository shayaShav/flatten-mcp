# flatten-mcp README Conversion — Audit & Rewrite Spec

**Status:** Draft v1 — 2026-06-27
**Scope:** Why cold readers bounce off the current README, and exactly what to change to convert them. Findings + prescribed rewrite. No code changes required — almost every fix is README/positioning.
**How produced:** a 7-persona "cold read" simulation across 3 model families (Codex x2, Gemini x2, Claude x3) via the llm-bridge MCP, a cited adoption-psychology research pass, a full source-code audit, and a cross-model DevRel critique (Gemini consult). Corrected by the maintainer on three points (see §7).
**Caveat:** personas are LLM-simulated, not real users — treat as high-confidence hypothesis generation. Strength = 7 independent personas plus external evidence converging on the same failures, each anchored to a quoted README line.

> **Status update (2026-06-28):** Since this audit, the *lean-tools + live-flatten* change shipped on `feature/2-live-flatten-lean-tools-readme`: **4 tools, not 6** (`list_sessions` and `search_sessions` were removed), the **10-second live-write guard and `force` are gone**, and **bare `/flatten` now flattens the current live session by default** (then `/resume` to load the lighter copy). Tool-count, `search_sessions`, two-window-ritual, and guard references below predate that change — treat them as the pre-change baseline and prefer the corrected facts in §2.

---

## 1. Corrected premise & positioning (READ FIRST)

The current README leads with compaction-avoidance ("Resume the exact same conversation ... without compacting it into a lossy summary"). Per the maintainer, that is a **selling point, not the point.**

- **True value proposition:** flatten reduces the tokens a session carries — which is **money on the API** and **usable-budget headroom on a subscription** (token = money / value either way).
- **Foundational thesis:** the bulk in a session (large file reads, logs, base64 screenshots) has *already been summarized into prose by the model* — the one line that mattered in a 2 MB log, the finding distilled from five files. The raw source has done its job, so setting it aside costs essentially nothing.
- **Differentiator (not headline):** unlike compaction, flatten is lossless and reversible — every prompt and the exact timeline stay verbatim.

Implications:
- Hero leads with **tokens/cost**, in the audience's words ("tokens", "burn", "money"); losslessness is the differentiator; the prose-redundancy thesis is the "why it's safe."
- Addressable audience is **everyone paying for / limited on tokens**, not only those who hit auto-compact. This widens the market and closes the relevance gap (§5 #6).
- A money pitch makes the **MCP overhead / break-even** question mandatory to answer (§6.1).

---

## 2. Product reality (verified in source — the problem is the README, not the product)

Confirmed by reading `src/index.ts`, `src/flattener.ts`, `src/session-store.ts`, `src/types.ts` in full:

- **Crash-safe.** Sidecar written before originals are removed; session rewritten via temp-file + atomic `rename`; backup via `COPYFILE_EXCL` (never overwrites the true original). An interrupted run cannot corrupt the session.
- **Reversible & lossless.** `unflatten_session` re-inlines stored originals byte-for-byte; prompts/order are never touched.
- **Idempotent.** Re-running skips already-flattened blocks; the sidecar never double-writes.
- **Private.** Zero network by default; one optional `count_tokens` call gated on `ANTHROPIC_API_KEY`; no telemetry.
- **4 tools:** `flatten_session`, `retrieve_flattened`, `unflatten_session`, `prune_flatten_artifacts`. (`list_sessions` and `search_sessions` were removed in the lean-tools change — see the status update above.)
- **Capabilities tested & demonstrated** by the maintainer (see §7.2).

**Conclusion: nearly every bounce below is a communication failure.** The README describes its scariest property (rewriting session files) vividly and its strongest properties (reversible, backed-up, atomic) quietly or late.

---

## 3. Methodology

- **Personas (7):** each given ONLY the README (what a discovery-stage reader sees), forced to quote the exact line that lost them, and to separate gut-bounce from considered hook. Fields: DevOps/security, indie founder, data scientist, frontend/screenshot-heavy, fintech security gatekeeper, eng manager, OSS power user.
- **Models:** Codex (Marcus, Priya), Gemini (Kenji, Sofia), Claude (David, Elena, Tom) — all via the llm-bridge MCP.
- **Bridge note:** the first Gemini run failed (Gemini CLI individual tier deprecated: "IneligibleTierError ... migrate to Antigravity"); a retry succeeded after auth was addressed.
- **Research pass:** a separate cited agent on README-abandonment psychology, MCP saturation, audience vocabulary, trust for file-mutating tools, and benchmark-number credibility (Appendix B).
- **Cross-model critique:** a senior-DevRel Gemini consult re-ranked the diagnosis and surfaced gaps (§6).

---

## 4. Verdict tally

**0 "install now", 4 "maybe-later", 3 "skip".** The two perfect-fit users (data-heavy sessions; Playwright screenshots) both skipped.

| Persona | Field | Model | Verdict | Line that lost them |
|---|---|---|---|---|
| Marcus | DevOps / security | Codex | Skip | `npx -y flatten-mcp@latest` before earning trust about rewriting `~/.claude` |
| Priya | Indie founder | Codex | Maybe-later | "Always exit the session… then flatten it from a different window" |
| Kenji | Data scientist | Gemini | Skip | "Requires Node.js ≥ 18" — won't add a JS toolchain to a Conda/ML env |
| Sofia | Frontend / screenshots | Gemini | Skip | "Why flatten instead of compact?" essay; her use-case buried in parentheses |
| David | Fintech gatekeeper | Claude | Maybe-later (no team greenlight) | "it's a quick read" ≠ an audit; no supply-chain provenance |
| Elena | Eng manager | Claude | Personal-use only | mandatory two-window ceremony = team adoption killer |
| Tom | OSS power user (ideal customer) | Claude | Maybe-later, leaning install | "up to ~50%" + the "bricks the session" risk |

---

## 5. Why readers bounce — ranked diagnosis (reconciled, funnel-staged)

### #1 — Name + tagline fail the 5-second "is this for me?" test — Comprehension leak (5/7)
- Quotes: David "sounds like it flattens data structures"; Elena "sounds like a JSON utility"; Marcus "MCP plumbing"; Sofia "backend LLM-bro jargon"; Kenji's stomach dropped at the npm/Node badges before reading a word.
- Mechanism: stay/leave decided in ~10s; the audience says "compact / context / forgets / lossy summary" and NEVER "flatten" — the word is invisible and forces a translation cold readers won't make.

### #2 — The naked video link wastes the single best asset: proof — Proof leak (7/7, every persona)
- Quote: bare `https://github.com/user-attachments/assets/4672b3cd…` URL. Priya "why is the proof a naked link?"; Kenji "looks like a markdown parsing error"; Sofia "instead of an embedded GIF I get a raw URL".
- Mechanism: visual proof above the fold is the highest-leverage README element; a mystery link delivers zero proof when it's needed most. Cheapest fix, highest return.

### #3 — "Bricks the session" + two-window ritual — Activation leak (5/7) [promoted by cross-model critique]
- Quotes: Tom "you describe a bricking failure mode with more vividness than you provide reassurance"; Priya "the word `bricks` just killed install intent"; Elena "asymmetric 'you broke your session' risk".
- Mechanism: loss aversion (a loss feels ~2x a gain) + activation friction (kill session → new window → command → resume). The readers most likely to convert abandon here.
- Code reality (updated 2026-06-28): the live-write guard and `force` were removed and live-flatten is now the default; the safety story is now atomic write + one-time backup + full reversibility (`/resume` loads the flattened copy), and it's still buried in "How it works". The two-window ritual is optional, not required.

### #4 — Philosophy essay buries the Quick Start — Time-to-value leak (4/7; positional, not intrinsic)
- Quotes: Elena "epistemology when I want a number"; Priya "founder-blog prose"; "the words you typed at 2 a.m." named by three personas.
- Mechanism: users read ~25% of text and scan heading-to-heading; the essay is misplaced, not bad. It only bounces people because the Quick Start sits beneath it.

### #5 — "up to ~50%" destroys the real, more-credible number — Credibility leak (2/7, incl. the ideal customer)
- Quote: Tom "the tilde killed it. The video shows 43% — just say it".
- Mechanism: FTC research — "up to X%" reads as what you *should expect* (anchors to the max), then disappoints; a precise real number (317,236 → 182,287) is measurably MORE credible than a round/hedged one.

### #6 — Relevance hidden from perfect-fit users — Relevance leak (2/7)
- Kenji: "Node.js ≥ 18" + `npx` + the lone `server.ts` example → "built by a JS dev, for JS devs". Sofia: the screenshot use-case is mentioned only inside parentheses.
- Mechanism: "is it for me?" fails when every example mirrors someone else's workflow. Largely closed by the §1 reframe (audience = "anyone paying for tokens").

### #7 — Enterprise/team + supply-chain blind spot — Trust/scale leak (2/7)
- David: no provenance / signed releases / checksums; "'four files, go read it' is not an approved answer for our security team." Both David & Elena: the README is entirely second-person-singular; never says "team / standardize / project-wide".

---

## 6. Objections the panel under-surfaced

1. **MCP "context tax" — code-backed and now load-bearing.** "I'm installing a context-saver that itself injects 4 tool schemas every turn." Tool descriptions in `index.ts` are long; per-turn overhead is real and unaddressed. With the §1 money reframe, the README must show the break-even (how many turns until net-save). For an audience whose loudest 2026 complaint is "MCP eats context" (Garry Tan; Perplexity moved off MCP), this is mandatory. **Strongest gap the persona panel missed.**
2. **"Will the model actually call `retrieve_flattened`, or hallucinate the missing data?"** Competence doubt. Address it truthfully (§7.3 / §8).
3. **"Won't Anthropic just ship this?"** Tom raised it. Reframe as a durable best practice (pulling raw bytes out of context is sound regardless of how compaction evolves), not a stopgap.
4. **Category fatigue.** ~52% of MCP servers are dead; "yet another MCP" skepticism is real. Antidotes: a clean demo, the verified safety story, stars/downloads.

---

## 7. Maintainer corrections incorporated

### 7.1 Premise
Compaction-avoidance is a selling point, not the point. Primary value = token/cost reduction (API money + subscription budget headroom). Foundation = the bulk is already summarized in prose. See §1.

### 7.2 "All capabilities were tested and demonstrated"
The audit overstepped by implying retrieval wasn't demonstrated. **Retracted.** The capabilities are real (verified in code) and tested/demonstrated by the maintainer. The only surviving point is README-scoped: it doesn't *show the reader* that demonstration — and that same recording is the missing above-the-fold proof asset.

### 7.3 Auto-fetch / "zero workflow breakage"
- Maintainer: it effectively does auto-extract-and-restore — as long as Anthropic doesn't change Claude's dirs/workflow and the exit flow is maintained, it reliably extracts and restores straight to the session file.
- Resolution: **SHIP the claim, framed conditional-empirical, not unconditional-absolute:**
  - Deterministic & provable: `unflatten` re-inlines byte-for-byte → claim flat-out.
  - Reliable-in-practice (the model deciding to call `retrieve_flattened`): "reliably, in practice (verified)", not "always / guaranteed".
  - State the two conditions the maintainer named (Anthropic session format unchanged; standard exit flow). These caveats are what make it bulletproof to skeptics; an unconditional "zero workflow breakage" is the one phrasing a Tom-type rejects on sight.

---

## 8. Copy-honesty guardrails

- Claim losslessness / reversibility / crash-safety flat-out (deterministic, verified).
- Claim retrieval / auto-restore as "reliable in practice, verified," **with** the two conditions (Anthropic session format unchanged; standard exit flow).
- Do NOT use unconditional absolutes ("zero workflow breakage", "always", "never fails").
- Use the real scoped number (43% on a read-heavy session; 317,236 → 182,287), not "up to ~50%".
- Back the strong claims with the recorded round-trip — proof doubles as honesty plus the missing demo GIF.

---

## 9. What would make them engage — ranked fixes

| # | Fix | Converts | Why |
|---|---|---|---|
| 1 | Embed a before/after GIF/asciinema under the tagline (token count dropping + a base64 screenshot collapsing into a `[FLATTENED]` marker + the model retrieving on demand) | All 7 (esp. Sofia) | Proof-before-install; kills the 7/7 bounce; doubles as the §7.2/§7.3 demonstration |
| 2 | Rewrite the first two lines in the audience's words — lead with tokens/cost; introduce "flatten" only after; add a "Who this is for" line | The 5 who failed the 5-sec test | Closes the vocabulary gap |
| 3 | Pull "crash-safe, backed-up, reversible" up to sit immediately after the CAUTION; reframe the two-window step as a deliberate "clean-room" safe path | Priya, Elena, Tom, Sofia | Neutralizes loss aversion + activation friction at the moment of doubt |
| 4 | Replace "up to ~50%" with the real number + scope + reason for variance | Tom + skeptics | Precise real beats hedged round; removes the FTC "up to" trap |
| 5 | Move the philosophy essay below the Quick Start (or to docs/) | Priya, Elena, Sofia | Restores time-to-value |
| 6 | Add a one-line MCP-overhead / break-even note | Power users | Pre-empts the context-tax objection |
| 7 | Multi-audience examples (`.csv`/`.ipynb` read, a Playwright screenshot, a log dump) — not just `server.ts` | Kenji, Sofia | Passes "is it for me?"; lifts the screenshot use-case out of parentheses |
| 8 | Lead Quick Start with the pinned version; add a "what it touches" line above install | Marcus, David | Containment-before-command |
| 9 | Short Teams/Enterprise note + Verification subsection (npm provenance, signed tag, integrity hash) | David, Elena | Gives gatekeepers an approval trail |

---

## 10. Two highest-leverage moves (one per leak)

- **Top-of-funnel (stop the 5-second bounce):** embedded before/after GIF + tagline in the reader's vocabulary, above the install. If forced to pick one, this wins — a reader who bounces at second 5 never reaches setup.
- **Activation (stop perfect-fit users abandoning at setup):** surface the safety story at the CAUTION and reframe the two-window ritual as the safe path. This flips Tom, Priya, Elena, Sofia from maybe-later to installed.
- Do both; they fix different holes.

---

## 11. Rewritten hero (corrected: token = money primary; honest conditionals)

```markdown
# flatten-mcp

> Cut the tokens every Claude Code session burns — real money on the API,
> more headroom before your limit on a subscription — without losing a line of history.

[ GIF: 317,236 → 182,287 tokens; the model retrieves a flattened block on demand; unflatten restores ]

Most of a long session's tokens are bulk the model already distilled into prose — the 2 MB
log it boiled down to one line, the screenshot it described, the five files it summarized.
That raw source has done its job. flatten-mcp moves it into a local sidecar and leaves a
small marker, so every resumed turn carries far fewer tokens. Your prompts and the exact
timeline stay verbatim — nothing is compacted into a lossy summary.

- Fewer tokens where it counts — shrinks the context carried on --resume, not just disk bytes.
- Lossless & reversible — backed up before any change; unflatten restores byte-for-byte.
- Crash-safe — atomic writes; an interrupted run can't corrupt your session.
- Self-restoring — the model fetches a flattened block on demand; unflatten re-inlines
  everything. (Verified on Claude Code's current session format, with the standard exit flow.)

Who this is for: heavy Claude Code users — large file reads, long logs, or screenshot-heavy
(Playwright) sessions — who want to pay for fewer tokens without losing their history.
```

---

## 12. Appendix A — full persona reactions

**Marcus — DevOps / security (Codex) — SKIP.** Biggest reason: asked to run `npx -y flatten-mcp@latest` before the README earns trust about rewriting `~/.claude`. Bounces: "moving bulky tool output… into a sidecar file" (wants threat model, not prose); the naked video link; "the words you typed at 2 a.m." (marketing essay); `npx @latest`; `curl … -o ~/.claude/commands/flatten.md` (no checksum, no pinned commit); "corrupts its in-memory state and bricks the session" (arrives *after* the install commands); "it's a quick read" belongs above Quick Start. Flip: a "what this touches" security block before Quick Start; pinned install first; move the brick warning above install.

**Priya — indie founder (Codex) — MAYBE-LATER.** Biggest reason: the two-window ritual feels risky and annoying exactly when overloaded. Bounces: "sidecar file" (implementation land); the naked proof link; "Why flatten instead of compact?" essay; "touch underwhelming" hedge; "Recommended — install the /flatten slash command" (so the one-liner isn't the real setup); the CAUTION; "bricks". Flip: a brutally short 30-second path at the top (payoff number → install → usage); embedded before/after visual; reframe the first warning around the safe workflow.

**Kenji — data scientist (Gemini) — SKIP.** Biggest reason: "Requires Node.js ≥ 18" + `npx` — won't pollute a clean Conda/ML environment with a JS toolchain. Bounces: the npm/Node badges ("stomach drops"); the naked video link; the web-dev example (`server.ts`, OOM); the Node requirement (killer). Flip: a `pip install` / `brew` / standalone binary; data-workflow examples (`.ipynb`, `.csv`); embed the video. Note: "This tool actually solves my exact problem… but the aggressive Node/NPM framing immediately alienates me."

**Sofia — frontend / screenshots (Gemini) — SKIP.** Biggest reason: README reads as written for a backend token-theory dev, not visual bloat; the manual Ctrl-C/new-window dance "sounds terrifyingly janky." Bounces: the raw video link (no embedded GIF); the "Why flatten instead of compact?" essay; the before/after shows a "log dump", not screenshots — her pain "buried inside parentheses"; the CAUTION. Flip: a GIF under the tagline showing base64 Playwright garbage collapsing into a `[FLATTENED]` tag; cut/move the essay; update the text-art to name "Base64 Screenshot". Note: "This tool is exactly for me… but the README completely buried the lede in parentheses."

**David — fintech gatekeeper (Claude) — MAYBE-LATER personal; NOT greenlit for team.** Biggest reason: no supply-chain integrity story (no provenance, signed releases, or checksums). Trust *spiked* at the Security section ("the best part… whoever wrote this has faced a skeptic before") but cratered at "it's a quick read" (≠ an audit) and the `@latest` default with the pinned-version hint buried ~1,500 words away. Flip: a Supply-chain/Verification subsection inside Security (npm provenance URL, signed tag, integrity hash); move the pinned-version hint into Quick Start; flag the `ANTHROPIC_API_KEY` network call in the config table. Relevance: it's for him, but the README never acknowledges the enterprise/team reader who needs an approval trail.

**Elena — eng manager (Claude) — PERSONAL-USE ONLY.** Biggest reason: the mandatory two-window ceremony is a team-adoption killer with asymmetric "you broke your session" risk for the median dev. Bounces: the philosophy section ("epistemology when I want a number"); the CAUTION; the three-step usage sequence; "touch underwhelming". Flip: a safe single-command path front-and-center; quantify savings in dollars per dev per week; surface "the original `.bak` is always preserved" right after the caution. Note: "a solo/power-user tool wearing a README that doesn't acknowledge teams exist" — all second-person-singular.

**Tom — OSS power user, the ideal customer (Claude) — MAYBE-LATER, leaning install.** Biggest reason: the Ctrl-C/two-window ritual + brick risk introduces a failure mode `/compact` doesn't have ("/compact is dumb but it's safe; this can brick"). Dips: "up to ~50%" ("the tilde killed it"); the CAUTION (heart-rate up); the five-step ritual; "prose-heavy sessions… negligible" (cuts his thinking-sessions use case); the mystery video link. Flip: replace "up to ~50%" with the real 317k→182k (43%) plus two more labeled examples; give a base-rate reassurance on the brick risk; answer "why isn't this in Claude Code?". Credibility verdict: convinced on losslessness, NOT on safety — "you describe a bricking failure mode with more vividness than you provide reassurance, and never give me base-rate data on how often that guard fires."

---

## 13. Appendix B — external research findings (cited)

### B.A — README abandonment psychology ("first 30 seconds" model)
- Stay/leave decided in the first ~10s; survive 30s → 2+ minutes. Users read ~25% of page text. "Communicate your value proposition within 10 seconds." (NN/g, ~205,873 pages / ~2B dwell times — nngroup.com/articles/how-long-do-users-stay-on-web-pages/)
- Aesthetic/credibility impression forms in ~50ms; the 5-second test is the canonical method. 94% of first impressions are design-influenced; 52% won't return after poor aesthetics. (nngroup.com/articles/first-impressions-human-automaticity/; uxcam.com/blog/ux-statistics/)
- Text is scanned in an F-pattern; antidotes: front-load the first two paragraphs, information-bearing headings, bold key terms, bullets. (nngroup.com/articles/f-shaped-pattern-reading-web-content/)
- Conversion drops ~95% as on-page elements grow 400→6,000; 90% read only headline + CTA. (seosherpa.com/landing-page-statistics/)
- README consensus: "~3 seconds to convince"; "first 2 lines: What is this? Why should I care?" (dev.to/juddiy/...-4gi2; dev.to/iris1031/...-2gb2)

### B.B — MCP saturation & trust fatigue (mid-2026)
- Server counts: LobeHub 56,000+; Glama 49,086; official Registry ~9,652; Smithery 7,000+; mcp.so ~20,000; PulseMCP 11,840. Anthropic cited "10,000+ active public servers" (Dec 2025).
- RapidClaw audit of 1,847 servers (Apr 2026): 52% dead, only 17% production-reasonable; median = 6 commits, 1 maintainer, 0 CI tests. Reddit/StackOne: "95% of MCP servers are utter garbage."
- "Yet another MCP" fatigue: Garry Tan "MCP sucks … eats too much context window" (Mar 2026); Perplexity moved off MCP; ~25 MCP builders per actual user (Glama).
- Security distrust: 38.7% of remote servers need no auth, only 8.5% OAuth; 102 MCP CVEs; CVE-2025-6514 (RCE in mcp-remote). Implication: the audience is primed to distrust exactly flatten's two scary properties — context use + touching local files.

### B.C — Claude Code context-pain vocabulary (verdict: "flatten" is invisible)
- Zero community uses of "flatten" across 10+ GitHub issues and 5+ HN threads. Dominant terms: **compact/compaction/auto-compact** (#1), **context / context window / context rot**, **forgets/forgetting** (emotional register), **token/burning tokens**, loses/lost, summarize/lossy, session/session state.
- Verbatim: "auto compact is the worst … makes everything worse" (anthropics/claude-code #13112); "Claude Code is definitely dumber after the compaction" (dolthub blog); "all summarised into oblivion" (golev.com); "no recovery path that preserves the session state" (#25620); "compaction death spiral" (#6541).
- Conclusion: lead with the audience's words; earn "flatten" only after recognition.

### B.D — Trust/risk for file-mutating tools (what de-risks adoption)
- Canonical trust pattern: propose → preview diff → apply/revert (Evil Martians). Dry-run as the *default* is the strongest safety signal (Terraform/kubectl `--dry-run`).
- GitLab agentic-UX research: pillar #1 is "safeguarding actions: confirmation + rollback. Users must know they can undo."
- Loss aversion ~2x (Kahneman/Tversky): fear of losing a `.jsonl` outweighs the gain — explicit backup/atomic/reversible messaging addresses a *cognitive* asymmetry.
- Stack Overflow 2025: 84% use AI tools, only 33% trust accuracy; 46% actively distrust. Adoption ≠ trust.
- Scoped + auditable is the community norm (Google Cloud "blast radius" of file-touching agents).
- De-risking copy: reversible / automatic backup / atomic (crash-safe) / verbatim / no telemetry / scoped to `~/.claude` / one-command undo. Visual proof (diff/before-after) beats prose.

### B.E — Converting-README best practices (ordered)
- Order: 1-sentence value prop → visual proof (before install) → ≤3-step copy-paste quick start (≤30s) → functional badges → features (tables > bullets) → FAQ.
- Hero image ≈ +35% star-rate; functional badges ≈ +40% perceived quality (directional, single-source). Optimal length 800–1,500 words.
- CLI tools lead with a 15–30s demo GIF (VHS/asciinema). Exemplars show the tool working *before* install: ripgrep, bat, fzf.
- MCP READMEs use config-as-quickstart (paste-ready JSON) — pair it with a one-glance savings visual. For flatten, the natural asset is an asciinema of the context bar dropping after one flatten.

### B.F — Reaction to savings/benchmark numbers
- Precise real numbers are MORE credible initially (Schley/OSU: 78% found a precise stat more believable; ACR body-spray study: skepticism higher for round "50%" than "47%/53%").
- But precision sets a higher bar; an imprecise estimate preserves trust better when reality differs (Pena-Marin & Wu, J. Consumer Psychology 2019).
- "up to X%" is the worst of both: the FTC finds consumers read it as what they *should expect* (anchors to the max), then disappoints.
- AI-benchmark cynicism is high (only 3% "highly trust" AI output; Goodhart/contamination awareness).
- Best formula for this audience: a specific real number + explicit scope/methodology + a stated reason for variance — not a hedged round "up to", not a bare precise claim.

### B.G — Top reasons a cold dev bounces in <30s (ranked)
1. No clear What/Why in the first 2 lines. 2. No visual proof above the fold. 3. Wall of text / no scannable headings (F-pattern misses the body). 4. Cognitive overload (too many elements). 5. Quick start buried/multi-step/not copy-paste. 6. "Reads like marketing" / vague adjectives. 7. Vocabulary mismatch (not the reader's words). 8. Trust/risk not addressed for file-touching tools (loss-aversion freeze). 9. Weak legitimacy signals (looks rushed, no functional badges). 10. Unbelievable or hedged numbers ("up to X%"). Niche 11th: "yet-another-MCP" fatigue + MCP security/context distrust.

### Bottom line for flatten-mcp
Three stacked headwinds in the first 30s: (1) a **vocabulary gap** — the audience says "compact/context/forgets/lossy summary" and never "flatten"; (2) a **file-mutation trust gap** — it rewrites `~/.claude` `.jsonl` in place, so reversible/backup/atomic/lossless/no-telemetry must be visible above the fold, ideally as a before/after visual; (3) a **category-fatigue + self-refuting-tax gap** — it's an MCP (52% of which are dead) in a moment when the loudest MCP complaint is that MCP itself eats context, so the README must pre-empt "doesn't this add overhead?" and prove savings with a specific, real, scoped number. Fastest lever: an above-the-fold asciinema/GIF of the context bar dropping, captioned with one real before/after token count and a one-line reversibility/backup guarantee — visual proof + the audience's vocabulary + a de-risking promise, before the install block.

---

## 14. Open questions / next actions

- [ ] Record the round-trip demo (token count dropping; the model retrieving a flattened block on demand; unflatten restoring). This single asset fixes the proof gap (#2), substantiates the auto-fetch claim (§7.3), and de-risks the brick fear (#3).
- [ ] Compute and state the MCP overhead break-even (per-turn schema cost vs tokens saved; after how many turns it nets positive). Required by the §1 money reframe (§6.1).
- [ ] Decide hero emphasis: subscription vs API, or keep both (current draft keeps both).
- [ ] Implement the README rewrite against §9–§11 (hero, reorder Quick Start above the essay, safety-at-CAUTION, real number, multi-audience examples, pinned-version + "what it touches", teams/verification section).
- [ ] Optional: a Teams/Enterprise note + Verification subsection (npm provenance, signed tag, integrity hash) for gatekeepers like David.

---

## 15. Provenance of this spec

- Personas via the llm-bridge MCP: Codex (Marcus, Priya), Gemini (Kenji, Sofia — succeeded on retry after a tier-auth failure), Claude agents (David, Elena, Tom).
- Research and cross-model critique: background research agent (cited above) + a Gemini DevRel consult.
- Source audit: all four files in `src/` read in full on 2026-06-27.
- Maintainer corrections (§7) applied 2026-06-27.
