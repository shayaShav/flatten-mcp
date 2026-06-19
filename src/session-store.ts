import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type { SessionMeta, SearchResult, ContentBlock } from './types.js';

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

export async function listSessionFiles(
    sessionDir: string,
    opts: { countMessages?: boolean } = {}
): Promise<SessionMeta[]> {
    // countMessages=false stops reading each session as soon as its branch and
    // first user message are known (messageCount stays 0). resolveSessionId and
    // searchSessions never use the count, so they take this fast path instead of
    // streaming every byte of every session on each call.
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

    const sessions = await listSessionFiles(sessionDir, { countMessages: false });
    if (sessions.length === 0) return [];

    // Sort by file modification time (newest first via timestamp)
    sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // "last" / "current" — both resolve to the most recent session. ("current"
    // is documented as the active session; the MCP cannot know the caller's own
    // session id, so it maps to the newest, guarded by the live-write check.)
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

/**
 * Stringify tool_result content, which can be a string, an array of
 * content blocks, or undefined.
 */
function stringifyToolResultContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((b: Record<string, unknown>) =>
                b.type === 'text' && typeof b.text === 'string' ? b.text : ''
            )
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

export async function searchSessions(
    sessionDir: string,
    query?: string,
    branch?: string,
    dateFrom?: string,
    dateTo?: string
): Promise<SearchResult[]> {
    const sessions = await listSessionFiles(sessionDir, { countMessages: false });
    const results: SearchResult[] = [];

    const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : 0;
    const dateToMs = dateTo ? new Date(dateTo).getTime() : Infinity;

    for (const session of sessions) {
        const sessionTime = new Date(session.timestamp).getTime();

        // Date filter
        if (sessionTime < dateFromMs || sessionTime > dateToMs) continue;

        // Branch filter
        if (branch && !session.gitBranch.toLowerCase().includes(branch.toLowerCase())) continue;

        // Query filter - scan file content
        if (query) {
            let matchCount = 0;
            let matchPreview = '';
            const queryLower = query.toLowerCase();

            const scanText = (text: string) => {
                const lower = text.toLowerCase();
                let idx = lower.indexOf(queryLower);
                while (idx !== -1) {
                    matchCount++;
                    if (!matchPreview) {
                        const start = Math.max(0, idx - 40);
                        const end = Math.min(text.length, idx + query.length + 40);
                        matchPreview = text.slice(start, end);
                    }
                    idx = lower.indexOf(queryLower, idx + 1);
                }
            };

            await streamJsonlLines(session.filePath, (parsed) => {
                const type = parsed.type as string;
                if (type !== 'user' && type !== 'assistant') return;

                const msg = parsed.message as { content: string | ContentBlock[] } | undefined;
                if (!msg) return;

                if (typeof msg.content === 'string') {
                    scanText(msg.content);
                } else if (Array.isArray(msg.content)) {
                    // Search prose AND tool I/O: tool_result output and tool_use
                    // inputs, not just text blocks — otherwise most of the
                    // session's substance is invisible to search.
                    for (const block of msg.content as ContentBlock[]) {
                        if (block.type === 'text' && block.text) {
                            scanText(block.text);
                        } else if (block.type === 'tool_result') {
                            scanText(stringifyToolResultContent(block.content));
                        } else if (block.type === 'tool_use' && block.input) {
                            scanText(JSON.stringify(block.input));
                        }
                    }
                }
            });

            // Also scan the flatten sidecar so content extracted by
            // flatten_session stays discoverable — otherwise flattening a
            // session would silently blind keyword search to its bulk.
            const sidecarPath = session.filePath.replace(/\.jsonl$/, '.flat.jsonl');
            try {
                await fs.access(sidecarPath);
                await streamJsonlLines(sidecarPath, (parsed) => {
                    const content = (parsed as { content?: unknown }).content;
                    if (content == null) return;
                    scanText(typeof content === 'string' ? content : JSON.stringify(content));
                });
            } catch {
                // no sidecar — nothing extra to search
            }

            if (matchCount > 0) {
                results.push({
                    sessionId: session.sessionId,
                    timestamp: session.timestamp,
                    gitBranch: session.gitBranch,
                    matchCount,
                    matchPreview,
                    fileSize: session.fileSize,
                });
            }
        } else {
            // No query — include all matching date/branch
            results.push({
                sessionId: session.sessionId,
                timestamp: session.timestamp,
                gitBranch: session.gitBranch,
                matchCount: 0,
                matchPreview: session.firstUserMessage,
                fileSize: session.fileSize,
            });
        }
    }

    return results;
}
