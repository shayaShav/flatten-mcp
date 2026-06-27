// Pure logic for the stdin/stdout CLI (cli.ts), split out so it can be unit tested
// without spawning a process or reading real stdin. No side effects: it takes argv
// plus the stdin string and returns the stdout string, throwing CliUsageError on bad
// usage or input. Runs over the same in-memory engine (core.ts) as the library
// exports and the MCP disk adapter — no network, no disk, no MCP.

import { flattenMessages, unflattenMessages, type ApiMessage, type ExtractedEntry } from './core.js';

export class CliUsageError extends Error {}

const USAGE =
    'Usage:\n' +
    '  flatten-mcp-cli --flatten [--min-size N]   (stdin: a messages[] array, or {"messages":[...],"minSize"?:N})\n' +
    '  flatten-mcp-cli --unflatten                (stdin: {"messages":[...],"extracted":[...]} — the --flatten output)';

/**
 * Run the CLI over an argv vector and a stdin string, returning the stdout string.
 * --flatten:   stdin is a raw messages[] array (or {messages, minSize?}); returns
 *              {messages, extracted, flattenedCount, imageBlocksFlattened, contextTokensSaved}.
 * --unflatten: stdin is {messages, extracted} (the --flatten output, extra keys
 *              ignored); returns {messages} restored byte-for-byte.
 */
export function runFlattenCli(argv: string[], input: string): string {
    const flatten = argv.includes('--flatten');
    const unflatten = argv.includes('--unflatten');
    if (flatten === unflatten) {
        throw new CliUsageError(`specify exactly one of --flatten or --unflatten.\n${USAGE}`);
    }

    if (!input.trim()) {
        throw new CliUsageError(`no JSON on stdin.\n${USAGE}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch (err) {
        throw new CliUsageError(`stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (flatten) {
        // --min-size on the command line wins over an inline "minSize" in the body.
        let minSize: number | undefined;
        const i = argv.indexOf('--min-size');
        if (i !== -1) {
            const raw = argv[i + 1];
            const n = Number(raw);
            if (raw === undefined || raw.trim() === '' || !Number.isFinite(n) || n < 0) {
                throw new CliUsageError(`--min-size needs a non-negative number, got: ${raw}`);
            }
            minSize = n;
        }

        // Accept a bare messages[] array or { messages, minSize? }.
        const messages = Array.isArray(parsed)
            ? (parsed as ApiMessage[])
            : (parsed as { messages?: ApiMessage[] }).messages;
        const inlineMinSize = !Array.isArray(parsed)
            ? (parsed as { minSize?: number }).minSize
            : undefined;
        if (!Array.isArray(messages)) {
            throw new CliUsageError('--flatten expects a JSON array of messages, or an object with a "messages" array.');
        }

        const effectiveMinSize = minSize ?? inlineMinSize;
        const result = flattenMessages(messages, effectiveMinSize !== undefined ? { minSize: effectiveMinSize } : {});
        return JSON.stringify(result);
    }

    // --unflatten
    const body = parsed as { messages?: ApiMessage[]; extracted?: ExtractedEntry[] };
    if (!Array.isArray(body.messages) || !Array.isArray(body.extracted)) {
        throw new CliUsageError('--unflatten expects a JSON object with "messages" and "extracted" arrays (the --flatten output).');
    }
    const restored = unflattenMessages(body.messages, body.extracted);
    return JSON.stringify({ messages: restored });
}
