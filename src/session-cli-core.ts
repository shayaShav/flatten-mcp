// Pure argument-handling core for the flatten-mcp-session bin, extracted so tests
// can exercise parsing and positional resolution without executing the CLI entry
// point (the same split as cli.ts / cli-core.ts for the stdin CLI).

export const USAGE = `flatten-mcp-session — flatten Claude Code sessions from the terminal (no LLM, no tokens)

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

export class UsageError extends Error {}

export interface ParsedArgs {
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
export function parseArgs(argv: string[]): ParsedArgs {
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

/**
 * Positional handling shared by every subcommand. Typed unquoted, the "last N"
 * selector arrives as two shell words (`flatten last 5`), so a leading
 * `last <digits>` pair is merged into the single "last N" selector that
 * resolveSessionId expects. Anything beyond the command's arity is a hard usage
 * error — extra positionals used to be silently ignored, which made
 * `flatten last 5` flatten only one session.
 */
export function resolvePositionals(command: string, positionals: string[], maxArity: number): string[] {
    const merged = [...positionals];
    if (merged.length >= 2 && merged[0] === 'last' && /^\d+$/.test(merged[1])) {
        merged.splice(0, 2, `last ${merged[1]}`);
    }
    if (merged.length > maxArity) {
        throw new UsageError(
            `${command}: unexpected argument(s): ${merged.slice(maxArity).join(' ')} — quote a multi-word selector if you meant one (e.g. "last 5").\n\n${USAGE}`
        );
    }
    return merged;
}
