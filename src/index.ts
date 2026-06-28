#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';

import {
    getSessionDir,
    resolveSessionId,
} from './session-store.js';

import {
    flattenSession,
    unflattenSession,
    retrieveFlattened,
} from './flattener.js';
import type { ContentBlock } from './types.js';

function resolveProjectDir(projectDir?: string): string {
    // Default to the project the CLI runs in. Claude Code spawns this stdio
    // server with cwd set to the workspace root, so process.cwd() IS that dir.
    // Pass project_dir explicitly to target a different project.
    // Relative segments like ".." would escape the per-project session dir
    // after encodeProjectDir, so only absolute paths are accepted.
    if (projectDir && !path.isAbsolute(projectDir)) {
        throw new Error(`project_dir must be an absolute path, got: ${projectDir}`);
    }
    return projectDir || process.cwd();
}

function resolveClaudeDir(claudeDir?: string): string | undefined {
    // undefined → session-store falls back to $CLAUDE_CONFIG_DIR or ~/.claude.
    // Accepts the Claude config dir (the one holding projects/), e.g. ~/.claude-2,
    // so a session in one profile can target another profile's session store.
    if (!claudeDir) return undefined;
    // Expand a leading "~/" for ergonomics, matching how profiles are named (~/.claude-2).
    const dir = claudeDir === '~' || claudeDir.startsWith('~/')
        ? path.join(os.homedir(), claudeDir.slice(1))
        : claudeDir;
    if (!path.isAbsolute(dir)) {
        throw new Error(`claude_dir must be an absolute path (or start with ~/), got: ${claudeDir}`);
    }
    return dir;
}

const server = new McpServer({
    name: 'flatten-mcp',
    version: '2.0.0',
});

// ─── Tool 1: flatten_session ────────────────────────────────────────

server.tool(
    'flatten_session',
    'Flatten a Claude Code session: move bulky tool results (large text output and base64 image/screenshot blocks) out of the session JSONL into a backup copy, leaving a compact [FLATTENED ...] marker. The conversation reads identically — every prompt and event stays verbatim — but resumes with far fewer context tokens. Crash-safe (atomic rewrite + a single backup holding the complete session) and reversible via unflatten_session. Reports diskBytesSaved and contextTokensSaved out of contextTokensTotal (estimated locally, or exact when ANTHROPIC_API_KEY is set). With no session_id, flattens the current live session; also accepts a UUID, "last", "last N", or "current". After flattening, /resume the session to load the lighter copy.',
    {
        session_id: z.string().optional().describe('Session UUID, "last", "last N", or "current". Omit to flatten the current live session.'),
        sessionId: z.string().optional().describe('camelCase alias for session_id (accepted so a camelCase call does not fail validation).'),
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/. Default: $CLAUDE_CONFIG_DIR if set, else ~/.claude.'),
        min_size: z.number().optional().default(1000).describe('Only flatten tool results larger than N bytes'),
        dry_run: z.boolean().optional().default(false).describe('Report what would be flattened without modifying files'),
        include_tool_use_result: z.boolean().optional().default(true).describe('Also flatten the top-level toolUseResult mirror Claude Code keeps per result line (roughly doubles disk savings; lossless & restorable). Set false to only touch message.content.'),
    },
    async ({ session_id, sessionId, project_dir, claude_dir, min_size, dry_run, include_tool_use_result }) => {
        // No session_id → "current", which resolveSessionId maps to the live
        // session via CLAUDE_CODE_SESSION_ID (set by Claude Code in this server's env).
        const sessionIdInput = session_id ?? sessionId ?? 'current';
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);
        const sessionIds = await resolveSessionId(sessionIdInput, sessionDir);

        if (sessionIds.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No matching sessions found.' }] };
        }

        const results = [];
        for (const sid of sessionIds) {
            const filePath = path.join(sessionDir, `${sid}.jsonl`);
            const result = await flattenSession(filePath, min_size, dry_run, include_tool_use_result);
            results.push({
                sessionId: sid,
                dryRun: dry_run,
                flattenedCount: result.flattenedCount,
                imageBlocksFlattened: result.imageBlocksFlattened,
                // DISK shrink — relevant to --resume parse speed.
                diskBytesSaved: result.bytesSaved,
                diskSavingsPercent: result.originalSize > 0
                    ? ((result.bytesSaved / result.originalSize) * 100).toFixed(1) + '%'
                    : '0%',
                // CONTEXT-token shrink — the number that matters for context/compaction.
                // Only message.content removals count; the toolUseResult mirror is disk-only.
                contextTokensTotal: result.contextTokensTotal,
                contextTokensSaved: result.contextTokensSaved,
                contextSavingsPercent: result.contextTokensTotal
                    ? ((result.contextTokensSaved / result.contextTokensTotal) * 100).toFixed(1) + '%'
                    : 'n/a',
                contextTokensExact: result.contextTokensExact,
                originalSize: result.originalSize,
                newSize: result.newSize,
                backupPath: result.backupPath,
                entries: result.entries,
                // The live-write reminder: a flattened session only takes effect once
                // Claude Code reloads it from disk. Surface this whenever we actually
                // rewrote a session (not a dry run, and something was flattened).
                resumeHint: (!dry_run && result.flattenedCount > 0)
                    ? 'Flattened in place. Now /resume this session (switch to another session and back) to load the lighter copy — until you do, this window still holds the full version.'
                    : undefined,
            });
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
            }],
        };
    }
);

// ─── Tool 2: retrieve_flattened ─────────────────────────────────────

server.tool(
    'retrieve_flattened',
    'Retrieve original tool result content from a flattened session, read straight from its backup. When you see [FLATTENED id=XXX tool=Read ... | text NNNB/NNL | session=YYY | ...] in the conversation, call this with the value after "id=" as tool_use_id and the value after "session=" as session_id. Returns the original text output, or — for flattened screenshots — the actual image so you can view it again.',
    {
        tool_use_id: z.string().describe('Value after "id=" in the [FLATTENED id=XXX ...] marker'),
        session_id: z.string().describe('Value after "session=" in the [FLATTENED ... session=YYY ...] marker'),
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
    },
    async ({ tool_use_id, session_id, project_dir, claude_dir }) => {
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);
        const backupPath = path.join(sessionDir, `${session_id}.jsonl.bak`);

        try {
            const result = await retrieveFlattened(backupPath, tool_use_id);

            const header = JSON.stringify({
                tool_use_id: result.tool_use_id,
                tool_name: result.tool_name,
                original_size: result.original_size,
                line_count: result.line_count,
                kind: result.kind,
                slot: result.slot,
            }, null, 2);

            const out: Array<
                | { type: 'text'; text: string }
                | { type: 'image'; data: string; mimeType: string }
            > = [{ type: 'text', text: header + '\n\n--- Original Content ---' }];

            const content = result.content;
            if (typeof content === 'string') {
                out.push({ type: 'text', text: content });
            } else if (Array.isArray(content)) {
                // message.content array: emit text inline and images as real image blocks.
                for (const block of content as ContentBlock[]) {
                    if (block.type === 'text' && block.text) {
                        out.push({ type: 'text', text: block.text });
                    } else if (block.type === 'image' && block.source?.data) {
                        out.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type ?? 'image/png' });
                    }
                }
            } else if (content && typeof content === 'object') {
                // toolUseResult mirror object. If it carries a screenshot, render it;
                // otherwise return the raw object as JSON. Both image shapes that
                // toolUseResultIsImage detects are handled here so retrieval renders
                // a real image rather than dumping base64 as text.
                const o = content as {
                    type?: string;
                    source?: { data?: string; media_type?: string };
                    file?: { base64?: string; type?: string };
                };
                if (o.file?.base64) {
                    out.push({ type: 'text', text: '[toolUseResult image]' });
                    out.push({ type: 'image', data: o.file.base64, mimeType: o.file.type ?? 'image/png' });
                } else if (o.type === 'image' && o.source?.data) {
                    out.push({ type: 'text', text: '[toolUseResult image]' });
                    out.push({ type: 'image', data: o.source.data, mimeType: o.source.media_type ?? 'image/png' });
                } else {
                    out.push({ type: 'text', text: JSON.stringify(content, null, 2) });
                }
            }

            return { content: out };
        } catch (err) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                }],
                isError: true,
            };
        }
    }
);

// ─── Tool 3: unflatten_session ──────────────────────────────────────

server.tool(
    'unflatten_session',
    'Reverse a flatten: re-inline every flattened tool result (text and images) back into the session JSONL from the backup, restoring the session to its pre-flatten state, then delete the backup so nothing is left behind.',
    {
        session_id: z.string().describe('Session UUID, "last", or "current" (the live session)'),
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
    },
    async ({ session_id, project_dir, claude_dir }) => {
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);
        const sessionIds = await resolveSessionId(session_id, sessionDir);

        if (sessionIds.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No matching sessions found.' }] };
        }

        const sid = sessionIds[0];
        const filePath = path.join(sessionDir, `${sid}.jsonl`);
        const backupPath = path.join(sessionDir, `${sid}.jsonl.bak`);
        const result = await unflattenSession(filePath, backupPath);

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    sessionId: sid,
                    skipped: result.skipped,
                    restoredCount: result.restoredCount,
                    notFound: result.notFound,
                    originalSize: result.originalSize,
                    newSize: result.newSize,
                    backupPath: result.backupPath,
                }, null, 2),
            }],
        };
    }
);

// ─── Start server ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
