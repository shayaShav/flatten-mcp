#!/usr/bin/env node
// Terminal CLI over the Claude Code session store — the disk counterpart to
// flatten-mcp-cli (which is the no-disk, messages[] adapter). This drives the SAME
// disk engine the MCP server uses (flattenSession / unflattenSession / retrieveFlattened
// over session-store resolution), so you can flatten, unflatten, list, and retrieve
// without an LLM turn and without spending any tokens. The only thing the MCP server
// does that this doesn't is run inside a live Claude Code session; everything else is
// identical because both call the same functions.
//
//   flatten-mcp-session flatten                     # flatten the most-recent session here
//   flatten-mcp-session flatten <id> --dry-run      # preview, write nothing
//   flatten-mcp-session unflatten <id>              # reverse a flatten, delete the backup
//   flatten-mcp-session list                        # list this project's sessions
//   flatten-mcp-session retrieve <id> <tool_use_id> # print/save one flattened block
//
// Session selector accepts a UUID, "last", "last N", "current", or a keyword (matched
// against the first user message / git branch) — the same grammar as the MCP tool.

import * as fs from 'fs/promises';
import * as path from 'path';

import {
    getSessionDir,
    resolveSessionId,
    resolveProjectDir,
    resolveClaudeDir,
    listSessions,
} from './session-store.js';
import {
    flattenSession,
    unflattenSession,
    retrieveFlattened,
} from './flattener.js';
import type { ContentBlock } from './types.js';

const USAGE = `flatten-mcp-session — flatten Claude Code sessions from the terminal (no LLM, no tokens)

Usage:
  flatten-mcp-session flatten   [<session>] [--dry-run] [--min-size N] [--no-tool-use-result]
  flatten-mcp-session unflatten <session>
  flatten-mcp-session list
  flatten-mcp-session retrieve  <session> <tool_use_id> [--out <file>]

  <session>   UUID, "last", "last N", "current", or a keyword. flatten defaults to "current"
              (the most-recent session in this project when run outside Claude Code).

Shared options:
  --project-dir <abs>   Project to target (default: current working directory)
  --claude-dir <dir>    Claude config dir holding projects/ (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --json                Emit machine-readable JSON instead of a human summary
  -h, --help            Show this help`;

class UsageError extends Error {}

interface ParsedArgs {
    positionals: string[];
    projectDir?: string;
    claudeDir?: string;
    json: boolean;
    dryRun: boolean;
    minSize?: number;
    includeToolUseResult: boolean;
    out?: string;
    help: boolean;
}

// Tiny dependency-free flag parser. Supports "--flag value" and "--flag=value" for
// value flags, and bare booleans. Anything not starting with "-" is a positional.
function parseArgs(argv: string[]): ParsedArgs {
    const out: ParsedArgs = {
        positionals: [],
        json: false,
        dryRun: false,
        includeToolUseResult: true,
        help: false,
    };

    const takeValue = (token: string, inlineValue: string | undefined, iter: { i: number }): string => {
        if (inlineValue !== undefined) return inlineValue;
        const next = argv[iter.i + 1];
        if (next === undefined) throw new UsageError(`${token} needs a value.`);
        iter.i += 1;
        return next;
    };

    const iter = { i: 0 };
    for (; iter.i < argv.length; iter.i++) {
        const token = argv[iter.i];
        const eq = token.startsWith('--') ? token.indexOf('=') : -1;
        const name = eq === -1 ? token : token.slice(0, eq);
        const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

        switch (name) {
            case '-h':
            case '--help':
                out.help = true;
                break;
            case '--json':
                out.json = true;
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            case '--no-tool-use-result':
                out.includeToolUseResult = false;
                break;
            case '--project-dir':
                out.projectDir = takeValue(name, inlineValue, iter);
                break;
            case '--claude-dir':
                out.claudeDir = takeValue(name, inlineValue, iter);
                break;
            case '--out':
                out.out = takeValue(name, inlineValue, iter);
                break;
            case '--min-size': {
                const raw = takeValue(name, inlineValue, iter);
                const n = Number(raw);
                if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
                    throw new UsageError(`--min-size needs a non-negative number, got: ${raw}`);
                }
                out.minSize = n;
                break;
            }
            default:
                if (name.startsWith('-')) throw new UsageError(`unknown option: ${name}`);
                out.positionals.push(token);
        }
    }

    return out;
}

function percent(part: number, whole: number | null): string {
    if (!whole || whole <= 0) return 'n/a';
    return ((part / whole) * 100).toFixed(1) + '%';
}

// Build the same report shape the MCP tool returns, so the CLI and the server agree
// field-for-field on what a flatten did.
function flattenReport(sid: string, dryRun: boolean, r: Awaited<ReturnType<typeof flattenSession>>) {
    return {
        sessionId: sid,
        dryRun,
        flattenedCount: r.flattenedCount,
        imageBlocksFlattened: r.imageBlocksFlattened,
        diskBytesSaved: r.bytesSaved,
        diskSavingsPercent: percent(r.bytesSaved, r.originalSize),
        contextTokensTotal: r.contextTokensTotal,
        contextTokensSaved: r.contextTokensSaved,
        contextSavingsPercent: percent(r.contextTokensSaved, r.contextTokensTotal),
        contextTokensExact: r.contextTokensExact,
        originalSize: r.originalSize,
        newSize: r.newSize,
        backupPath: r.backupPath,
    };
}

function printFlattenHuman(rep: ReturnType<typeof flattenReport>): void {
    const tag = rep.dryRun ? ' (dry run — nothing written)' : '';
    const lines = [
        `Session ${rep.sessionId}${tag}`,
        `  flattened blocks : ${rep.flattenedCount}${rep.imageBlocksFlattened ? ` (${rep.imageBlocksFlattened} images)` : ''}`,
        `  context tokens   : ${rep.contextTokensSaved} saved of ${rep.contextTokensTotal ?? 'n/a'} (${rep.contextSavingsPercent})${rep.contextTokensExact ? ' exact' : ' estimated'}`,
        `  disk bytes       : ${rep.diskBytesSaved} saved of ${rep.originalSize} (${rep.diskSavingsPercent})`,
        `  backup           : ${rep.backupPath}`,
    ];
    if (!rep.dryRun && rep.flattenedCount > 0) {
        lines.push('  note             : if this session is open in Claude Code, /resume it (switch away and back) to load the lighter copy.');
    }
    process.stdout.write(lines.join('\n') + '\n');
}

async function cmdFlatten(args: ParsedArgs): Promise<void> {
    const sessionInput = args.positionals[0] ?? 'current';
    const sessionDir = getSessionDir(resolveProjectDir(args.projectDir), resolveClaudeDir(args.claudeDir));
    const ids = await resolveSessionId(sessionInput, sessionDir);
    if (ids.length === 0) throw new UsageError('No matching sessions found.');

    const reports = [];
    for (const sid of ids) {
        const filePath = path.join(sessionDir, `${sid}.jsonl`);
        const result = await flattenSession(filePath, args.minSize ?? 1000, args.dryRun, args.includeToolUseResult);
        reports.push(flattenReport(sid, args.dryRun, result));
    }

    if (args.json) {
        process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + '\n');
    } else {
        reports.forEach(printFlattenHuman);
    }
}

async function cmdUnflatten(args: ParsedArgs): Promise<void> {
    const sessionInput = args.positionals[0];
    if (!sessionInput) throw new UsageError('unflatten needs a <session> (UUID, "last", "current", or keyword).');

    const sessionDir = getSessionDir(resolveProjectDir(args.projectDir), resolveClaudeDir(args.claudeDir));
    const ids = await resolveSessionId(sessionInput, sessionDir);
    if (ids.length === 0) throw new UsageError('No matching sessions found.');

    const sid = ids[0];
    const filePath = path.join(sessionDir, `${sid}.jsonl`);
    const backupPath = path.join(sessionDir, `${sid}.jsonl.bak`);
    const r = await unflattenSession(filePath, backupPath);

    const report = {
        sessionId: sid,
        skipped: r.skipped,
        restoredCount: r.restoredCount,
        notFound: r.notFound,
        originalSize: r.originalSize,
        newSize: r.newSize,
        backupPath: r.backupPath,
    };

    if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
    }
    if (r.skipped) {
        process.stdout.write(`Session ${sid}: ${r.skipped}\n`);
        return;
    }
    const lines = [
        `Session ${sid} unflattened`,
        `  restored blocks : ${r.restoredCount}${r.notFound.length ? ` (${r.notFound.length} not found in backup)` : ''}`,
        `  size            : ${r.originalSize} -> ${r.newSize} bytes`,
        `  backup          : removed (${r.backupPath})`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
}

async function cmdList(args: ParsedArgs): Promise<void> {
    const sessionDir = getSessionDir(resolveProjectDir(args.projectDir), resolveClaudeDir(args.claudeDir));
    const sessions = await listSessions(sessionDir);

    if (args.json) {
        process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
        return;
    }
    if (sessions.length === 0) {
        process.stdout.write('No sessions found for this project.\n');
        return;
    }
    process.stdout.write(`${sessions.length} session(s), newest first:\n`);
    for (const s of sessions) {
        const when = s.timestamp ? s.timestamp.replace('T', ' ').slice(0, 19) : '';
        const kb = (s.fileSize / 1024).toFixed(0);
        const first = s.firstUserMessage.replace(/\s+/g, ' ').slice(0, 60);
        process.stdout.write(`  ${s.sessionId}  ${when}  ${kb}KB  ${s.gitBranch || '-'}  ${first}\n`);
    }
}

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

async function writeImage(id: string, data: string, mimeType: string, outArg: string | undefined): Promise<string> {
    const ext = EXT_BY_MIME[mimeType] ?? 'bin';
    const safeId = id.replace(/[^A-Za-z0-9_.#-]/g, '_');
    const outPath = outArg ?? `${safeId}.${ext}`;
    await fs.writeFile(outPath, Buffer.from(data, 'base64'));
    return outPath;
}

async function cmdRetrieve(args: ParsedArgs): Promise<void> {
    const sessionInput = args.positionals[0];
    const toolUseId = args.positionals[1];
    if (!sessionInput || !toolUseId) {
        throw new UsageError('retrieve needs <session> and <tool_use_id> (the id= value from a [FLATTENED ...] marker).');
    }

    const sessionDir = getSessionDir(resolveProjectDir(args.projectDir), resolveClaudeDir(args.claudeDir));
    const ids = await resolveSessionId(sessionInput, sessionDir);
    if (ids.length === 0) throw new UsageError('No matching sessions found.');

    const sid = ids[0];
    const backupPath = path.join(sessionDir, `${sid}.jsonl.bak`);
    const result = await retrieveFlattened(backupPath, toolUseId);
    const content = result.content;

    // Images can't render in a terminal — write them to a file and report the path.
    // Text is printed to stdout (after a header on stderr so piping stdout stays clean).
    process.stderr.write(`# ${result.tool_name} ${result.tool_use_id} | ${result.kind} ${result.original_size}B/${result.line_count}L | slot=${result.slot}\n`);

    if (typeof content === 'string') {
        process.stdout.write(content + '\n');
        return;
    }
    if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
            if (block.type === 'text' && block.text) {
                process.stdout.write(block.text + '\n');
            } else if (block.type === 'image' && block.source?.data) {
                const p = await writeImage(toolUseId, block.source.data, block.source.media_type ?? 'image/png', args.out);
                process.stderr.write(`[image written to ${p}]\n`);
            }
        }
        return;
    }
    if (content && typeof content === 'object') {
        const o = content as { type?: string; source?: { data?: string; media_type?: string }; file?: { base64?: string; type?: string } };
        if (o.file?.base64) {
            const p = await writeImage(toolUseId, o.file.base64, o.file.type ?? 'image/png', args.out);
            process.stderr.write(`[image written to ${p}]\n`);
        } else if (o.type === 'image' && o.source?.data) {
            const p = await writeImage(toolUseId, o.source.data, o.source.media_type ?? 'image/png', args.out);
            process.stderr.write(`[image written to ${p}]\n`);
        } else {
            process.stdout.write(JSON.stringify(content, null, 2) + '\n');
        }
    }
}

// Exit quietly when a downstream consumer closes the pipe early (e.g. `| head`,
// or quitting `less`). Without this, the EPIPE surfaces as an unhandled 'error'
// event on stdout and crashes with a stack trace mid-output.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
});

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const command = argv[0];

    if (!command || command === '-h' || command === '--help' || command === 'help') {
        process.stdout.write(USAGE + '\n');
        return;
    }

    const args = parseArgs(argv.slice(1));
    if (args.help) {
        process.stdout.write(USAGE + '\n');
        return;
    }

    switch (command) {
        case 'flatten':
            await cmdFlatten(args);
            break;
        case 'unflatten':
            await cmdUnflatten(args);
            break;
        case 'list':
            await cmdList(args);
            break;
        case 'retrieve':
            await cmdRetrieve(args);
            break;
        default:
            throw new UsageError(`unknown command: ${command}\n\n${USAGE}`);
    }
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`flatten-mcp-session: ${msg}\n`);
    process.exitCode = 1;
});
