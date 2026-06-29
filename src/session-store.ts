import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type { SessionMeta, ContentBlock } from './types.js';

// Base Claude config dir. Honors CLAUDE_CONFIG_DIR — the same env var Claude Code
// itself uses to select a profile (e.g. ~/.claude-2) — so a server spawned inside
// an alternate profile automatically targets that profile's session store instead
// of the default ~/.claude. Callers can override per call via getSessionDir(..., claudeDir).
function defaultClaudeDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude Code stores each project's sessions under <claudeDir>/projects/<encoded>,
// where <encoded> is the project's absolute path with every "/" turned into "-".
function encodeProjectDir(absolutePath: string): string {
    return absolutePath.replace(/\//g, '-');
}

export function getSessionDir(projectDir: string, claudeDir?: string): string {
    return path.join(claudeDir || defaultClaudeDir(), 'projects', encodeProjectDir(projectDir));
}

// Resolve the project dir to operate on. Defaults to the process cwd — Claude Code
// spawns the stdio server with cwd set to the workspace root, and the CLI runs in the
// project you invoke it from. Relative segments like ".." would escape the per-project
// session dir after encodeProjectDir, so only absolute paths are accepted.
export function resolveProjectDir(projectDir?: string): string {
    if (projectDir && !path.isAbsolute(projectDir)) {
        throw new Error(`project_dir must be an absolute path, got: ${projectDir}`);
    }
    return projectDir || process.cwd();
}

// Resolve the Claude config dir (the one holding projects/), e.g. ~/.claude-2, so a
// caller in one profile can target another profile's session store. undefined → the
// session-store falls back to $CLAUDE_CONFIG_DIR or ~/.claude. A leading "~/" is
// expanded for ergonomics, matching how profiles are named.
export function resolveClaudeDir(claudeDir?: string): string | undefined {
    if (!claudeDir) return undefined;
    const dir = claudeDir === '~' || claudeDir.startsWith('~/')
        ? path.join(os.homedir(), claudeDir.slice(1))
        : claudeDir;
    if (!path.isAbsolute(dir)) {
        throw new Error(`claude_dir must be an absolute path (or start with ~/), got: ${claudeDir}`);
    }
    return dir;
}

async function streamJsonlLines(
    filePath: string,
    callback: (parsed: Record<string, unknown>, lineNumber: number) => boolean | void
): Promise<void> {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const stop = callback(parsed, lineNumber);
            if (stop === true) {
                rl.close();
                stream.destroy();
                return;
            }
        } catch {
            // skip malformed lines
        }
        lineNumber++;
    }
}

async function listSessionFiles(
    sessionDir: string,
    opts: { countMessages?: boolean } = {}
): Promise<SessionMeta[]> {
    // countMessages=false stops reading each session as soon as its branch and
    // first user message are known (messageCount stays 0). resolveSessionId never
    // uses the count, so it takes this fast path instead of streaming every byte
    // of every session on each call.
    const countMessages = opts.countMessages !== false;

    let entries: string[];
    try {
        entries = await fs.readdir(sessionDir);
    } catch {
        return [];
    }

    const jsonlFiles = entries.filter(e => e.endsWith('.jsonl') && !e.endsWith('.flat.jsonl') && !e.endsWith('.bak'));

    const results: SessionMeta[] = [];
    for (const file of jsonlFiles) {
        const filePath = path.join(sessionDir, file);
        const stat = await fs.stat(filePath);
        const sessionId = file.replace('.jsonl', '');

        let lastTimestamp = '';
        let gitBranch = '';
        let firstUserMessage = '';
        let messageCount = 0;

        await streamJsonlLines(filePath, (parsed) => {
            const type = parsed.type as string;
            if (countMessages && (type === 'user' || type === 'assistant')) {
                messageCount++;
            }
            if (typeof parsed.timestamp === 'string') {
                lastTimestamp = parsed.timestamp;
            }
            if (type === 'user') {
                if (!gitBranch && parsed.gitBranch) {
                    gitBranch = parsed.gitBranch as string;
                }
                if (!firstUserMessage && parsed.message) {
                    const msg = parsed.message as { content: string | ContentBlock[] };
                    if (typeof msg.content === 'string') {
                        firstUserMessage = msg.content.slice(0, 200);
                    } else if (Array.isArray(msg.content)) {
                        for (const block of msg.content) {
                            if (block.type === 'text' && block.text) {
                                firstUserMessage = block.text.slice(0, 200);
                                break;
                            }
                        }
                    }
                }
            }
            // Fast path: stop streaming once we have everything the light caller needs.
            if (!countMessages && gitBranch && firstUserMessage) {
                return true;
            }
        });

        results.push({
            sessionId,
            // Recency source: a full scan uses the last message's timestamp; the fast
            // path stops early and can't reach the last line, so it uses file mtime.
            timestamp: countMessages ? (lastTimestamp || stat.mtime.toISOString()) : stat.mtime.toISOString(),
            gitBranch,
            messageCount,
            fileSize: stat.size,
            firstUserMessage,
            filePath,
        });
    }

    return results;
}

export async function resolveSessionId(
    sessionId: string,
    sessionDir: string
): Promise<string[]> {
    // UUID format
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
        return [sessionId];
    }

    // "current" — the live session. Claude Code sets CLAUDE_CODE_SESSION_ID in the
    // server's environment to the session it spawned this process for, so we target
    // it exactly without scanning the directory. Falls through to most-recent below
    // when unset (e.g. the server was not launched by Claude Code).
    if (sessionId === 'current' && process.env.CLAUDE_CODE_SESSION_ID) {
        return [process.env.CLAUDE_CODE_SESSION_ID];
    }

    const sessions = await listSessionFiles(sessionDir, { countMessages: false });
    if (sessions.length === 0) return [];

    // Sort by file modification time (newest first via timestamp)
    sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // "last", or "current" when CLAUDE_CODE_SESSION_ID is unset — most recent session.
    if (sessionId === 'last' || sessionId === 'current') {
        return [sessions[0].sessionId];
    }

    // "last N"
    const lastNMatch = sessionId.match(/^last\s+(\d+)$/);
    if (lastNMatch) {
        const n = parseInt(lastNMatch[1], 10);
        return sessions.slice(0, n).map(s => s.sessionId);
    }

    // Keyword search in first user messages
    const keyword = sessionId.toLowerCase();
    const matched = sessions.filter(s =>
        s.firstUserMessage.toLowerCase().includes(keyword) ||
        s.gitBranch.toLowerCase().includes(keyword)
    );
    return matched.map(s => s.sessionId);
}

// Public listing of a project's sessions, newest first — used by the session CLI's
// `list` command so a terminal caller can discover session ids and recency without
// the MCP server. Counts messages by default (the full per-session scan).
export async function listSessions(sessionDir: string): Promise<SessionMeta[]> {
    const sessions = await listSessionFiles(sessionDir);
    sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return sessions;
}
