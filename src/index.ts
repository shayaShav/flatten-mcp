#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

import {
    getSessionDir,
    listSessionFiles,
    resolveSessionId,
    searchSessions,
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
    version: '1.1.0',
});

// ─── Tool 1: list_sessions ──────────────────────────────────────────

server.tool(
    'list_sessions',
    'List Claude Code sessions for a project with metadata (sessionId, branch, message count, file size, first user message).',
    {
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
        limit: z.number().optional().default(20).describe('Max sessions to return'),
        sort: z.enum(['newest', 'oldest', 'largest']).optional().default('newest'),
    },
    async ({ project_dir, claude_dir, limit, sort }) => {
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);
        const sessions = await listSessionFiles(sessionDir);

        if (sort === 'newest') {
            sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        } else if (sort === 'oldest') {
            sessions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        } else if (sort === 'largest') {
            sessions.sort((a, b) => b.fileSize - a.fileSize);
        }

        const page = sessions.slice(0, limit).map(s => ({
            sessionId: s.sessionId,
            timestamp: s.timestamp,
            gitBranch: s.gitBranch,
            messageCount: s.messageCount,
            fileSize: s.fileSize,
            firstUserMessage: s.firstUserMessage,
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(page, null, 2) }] };
    }
);

// ─── Tool 2: search_sessions ────────────────────────────────────────

server.tool(
    'search_sessions',
    'Search past sessions by keyword, date range, or git branch. Scans prose, tool I/O, and flatten sidecars; returns matching sessions with a match count and a text preview.',
    {
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
        query: z.string().optional().describe('Keyword to search in conversation text'),
        branch: z.string().optional().describe('Filter by git branch name'),
        date_from: z.string().optional().describe('ISO date lower bound'),
        date_to: z.string().optional().describe('ISO date upper bound'),
        limit: z.number().optional().default(10).describe('Max results to return'),
    },
    async ({ project_dir, claude_dir, query, branch, date_from, date_to, limit }) => {
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);
        const results = await searchSessions(sessionDir, query, branch, date_from, date_to);

        return { content: [{ type: 'text' as const, text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    }
);

// ─── Tool 3: flatten_session ────────────────────────────────────────

server.tool(
    'flatten_session',
    'Flatten a session: move bulky tool results (large text output and base64 image/screenshot blocks) out of the session JSONL into a sidecar file, leaving a lightweight [FLATTENED ...] marker in their place. The conversation reads identically — every prompt and event stays verbatim — but resumes with far fewer context tokens. Crash-safe (atomic rewrite + idempotent sidecar) and fully reversible via unflatten_session. Reports diskBytesSaved (file shrink, affects --resume parse speed) and contextTokensSaved out of contextTokensTotal (the number that matters for compaction); token savings are estimated locally, or exact when ANTHROPIC_API_KEY is set. Accepts a UUID, "last", "last N", or "current". Refuses to rewrite a session edited in the last 10s (likely live) unless force=true.',
    {
        session_id: z.string().optional().describe('Session UUID, "last", "last N", or "current" (most recent). Any other value is treated as a keyword matched against first messages and branch names, and may flatten MULTIPLE matching sessions — prefer a UUID here.'),
        sessionId: z.string().optional().describe('camelCase alias for session_id (the list_sessions output uses this name). Use session_id; this is accepted so a camelCase call does not fail validation.'),
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
        min_size: z.number().optional().default(1000).describe('Only flatten tool results larger than N bytes'),
        dry_run: z.boolean().optional().default(false).describe('Report what would be flattened without modifying files'),
        force: z.boolean().optional().default(false).describe('Flatten even if the session was modified seconds ago (may be live). Use only when the session is idle.'),
        include_tool_use_result: z.boolean().optional().default(true).describe('Also flatten the top-level toolUseResult mirror Claude Code keeps per result line (roughly doubles disk savings; lossless & restorable). Set false to only touch message.content.'),
    },
    async ({ session_id, sessionId, project_dir, claude_dir, min_size, dry_run, force, include_tool_use_result }) => {
        const sessionIdInput = session_id ?? sessionId;
        if (!sessionIdInput) {
            return { content: [{ type: 'text' as const, text: 'session_id is required (UUID, "last", "last N", or "current").' }] };
        }
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
            const result = await flattenSession(filePath, min_size, dry_run, force, include_tool_use_result);
            results.push({
                sessionId: sid,
                dryRun: dry_run,
                skipped: result.skipped,
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
                sidecarPath: result.sidecarPath,
                backupPath: result.backupPath,
                entries: result.entries,
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

// ─── Tool 4: retrieve_flattened ─────────────────────────────────────

server.tool(
    'retrieve_flattened',
    'Retrieve original tool result content from a flattened session. When you see [FLATTENED id=XXX tool=Read ... | text NNNB/NNL | session=YYY | ...] in the conversation, call this with the value after "id=" as tool_use_id and the value after "session=" as session_id. Returns the original text output, or — for flattened screenshots — the actual image so you can view it again.',
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
        const sidecarPath = path.join(sessionDir, `${session_id}.flat.jsonl`);

        try {
            const result = await retrieveFlattened(sidecarPath, tool_use_id);

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

// ─── Tool 5: unflatten_session ──────────────────────────────────────

server.tool(
    'unflatten_session',
    'Reverse a flatten: re-inline every flattened tool result (text and images) back into the session JSONL from its sidecar, restoring the session to its pre-flatten state. Snapshots the flattened file to <file>.preunflatten.bak first.',
    {
        session_id: z.string().describe('Session UUID, "last", or "current" (most recent)'),
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
        const sidecarPath = path.join(sessionDir, `${sid}.flat.jsonl`);
        const result = await unflattenSession(filePath, sidecarPath);

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

// ─── Tool 6: prune_flatten_artifacts ────────────────────────────────

server.tool(
    'prune_flatten_artifacts',
    'Reclaim disk by deleting leftover flatten artifacts (.bak, .preunflatten.bak, and stale .tmp-<pid> files) for a project. By default keeps .flat.jsonl sidecars (retrieve_flattened needs them) and runs dry. Set include_sidecars=true only when you no longer need to retrieve/unflatten those sessions.',
    {
        project_dir: z.string().optional().describe('Absolute path to project. Default: the project the CLI runs in (cwd)'),
        claude_dir: z.string().optional().describe('Absolute path (or ~/...) to the Claude config dir whose sessions to target — the dir holding projects/, e.g. ~/.claude-2 for a second profile. Default: $CLAUDE_CONFIG_DIR if set (so a server running inside an alternate profile targets it), else ~/.claude.'),
        older_than_days: z.number().optional().default(0).describe('Only delete artifacts whose mtime is older than N days. 0 = no age limit.'),
        include_sidecars: z.boolean().optional().default(false).describe('Also delete .flat.jsonl sidecars. WARNING: retrieve_flattened/unflatten_session stop working for those sessions.'),
        dry_run: z.boolean().optional().default(true).describe('Report what would be deleted without deleting. Default true for safety.'),
    },
    async ({ project_dir, claude_dir, older_than_days, include_sidecars, dry_run }) => {
        const projectDir = resolveProjectDir(project_dir);
        const claudeDir = resolveClaudeDir(claude_dir);
        const sessionDir = getSessionDir(projectDir, claudeDir);

        let entries: string[];
        try {
            entries = await fs.readdir(sessionDir);
        } catch {
            return { content: [{ type: 'text' as const, text: `No session directory at ${sessionDir}` }] };
        }

        const isArtifact = (name: string): boolean =>
            name.endsWith('.bak') ||
            /\.tmp-\d+$/.test(name) ||
            (include_sidecars && name.endsWith('.flat.jsonl'));

        const cutoffMs = older_than_days > 0 ? Date.now() - older_than_days * 86_400_000 : Infinity;

        const deleted: Array<{ file: string; bytes: number }> = [];
        let bytesFreed = 0;

        for (const name of entries) {
            if (!isArtifact(name)) continue;
            const filePath = path.join(sessionDir, name);
            const stat = await fs.stat(filePath);
            if (older_than_days > 0 && stat.mtimeMs > cutoffMs) continue;
            deleted.push({ file: name, bytes: stat.size });
            bytesFreed += stat.size;
            if (!dry_run) await fs.unlink(filePath);
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    dryRun: dry_run,
                    sessionDir,
                    includeSidecars: include_sidecars,
                    olderThanDays: older_than_days,
                    fileCount: deleted.length,
                    bytesFreed,
                    mbFreed: (bytesFreed / (1024 * 1024)).toFixed(2),
                    files: deleted,
                }, null, 2),
            }],
        };
    }
);

// ─── Start server ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
