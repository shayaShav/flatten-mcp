---
description: Flatten a Claude Code session via *flatten-mcp* ONLY (not via bash). Move bulky tool output to a sidecar, keep silent and only give back summarized flattening stats.
argument-hint: [<session-uuid> | latest]
allowed-tools: mcp__flatten__flatten_session, mcp__flatten__list_sessions
---

Flatten a Claude Code session using the **flatten** MCP server. Target: "$ARGUMENTS" (empty or "latest" = most recent flattenable session).

Rules:
1. A session UUID → call `flatten_session` with it directly.
2. "latest" or empty → call `list_sessions` (sort: newest, limit: 2) and flatten the **larger** of the two most recent sessions, by UUID. The smaller, seconds-old one is almost always this very window — the session worth flattening is the big one.
3. NEVER pass `force: true`. A guard refusal means the session is in use; report it, don't override it.
4. Report `flattenedCount`, `contextTokensSaved` of `contextTokensTotal` (with %), and `diskBytesSaved`.
