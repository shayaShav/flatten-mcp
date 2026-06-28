---
description: Flatten the current (or a specified) Claude Code session via *flatten-mcp* ONLY (not via bash). Move bulky tool output to a sidecar; report the summarized flattening stats and the /resume reminder.
argument-hint: [<session-uuid>]
allowed-tools: mcp__flatten__flatten_session, mcp__plugin_flatten-mcp_flatten__flatten_session
---

Flatten a Claude Code session using the **flatten** MCP server. Target: "$ARGUMENTS" (empty = the current live session).

Rules:
1. No argument → call `flatten_session` with no `session_id`. The server flattens the current live session, which it identifies from `CLAUDE_CODE_SESSION_ID` in its own environment.
2. A session UUID → call `flatten_session` with that value as `session_id`.
3. Use the MCP tool only — never flatten via bash.
4. Report `flattenedCount`, `contextTokensSaved` of `contextTokensTotal` (with %), and `diskBytesSaved`. Then surface the result's `resumeHint` verbatim: the user must **`/resume`** this session (switch to another session and back) for the flattened, lighter copy to load.
