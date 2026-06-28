#!/usr/bin/env node
// stdin/stdout CLI over the in-memory flatten engine, so callers in ANY language
// (Python, Go, shell, …) that hold a raw Anthropic Messages API `messages[]` array
// can flatten it without importing the JS library — no server, no MCP, no disk, no
// network. Same core as the MCP server and the flattenMessages/unflattenMessages
// exports.
//
//   echo '[{"role":"user","content":"hi"}]' | flatten-mcp-cli --flatten
//   flatten-mcp-cli --flatten --min-size 2000 < body.json > flattened.json
//   flatten-mcp-cli --unflatten < flattened.json > restored.json
//
// All parsing/serialization lives in cli-core.ts (runFlattenCli) so it stays unit
// testable; this file only wires stdin/stdout/argv and the exit code.

import { runFlattenCli, CliUsageError } from './cli-core.js';

async function readStdin(): Promise<string> {
    process.stdin.setEncoding('utf-8');
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

async function main(): Promise<void> {
    const input = await readStdin();
    try {
        process.stdout.write(runFlattenCli(process.argv.slice(2), input) + '\n');
    } catch (err) {
        const msg = err instanceof CliUsageError || err instanceof Error ? err.message : String(err);
        process.stderr.write(`flatten-mcp-cli: ${msg}\n`);
        process.exitCode = 1;
    }
}

main();
