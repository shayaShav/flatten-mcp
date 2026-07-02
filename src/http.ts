#!/usr/bin/env node
// flatten-mcp-http — the in-memory flatten engine over MCP Streamable HTTP.
// Serves flatten_messages/unflatten_messages (stateless, no disk, no outbound
// network) so hosted registry inspectors and remote MCP clients can call the
// engine interactively. The disk tools are NOT exposed here — they need the
// local Claude Code session store, which a remote caller does not have; use the
// stdio server (flatten-mcp) or the session CLI for those.
//
//   flatten-mcp-http                     # 127.0.0.1:8787
//   flatten-mcp-http --port 3000
//   flatten-mcp-http --host 0.0.0.0     # expose beyond localhost — read the note below
//
// No auth and permissive CORS (what lets browser inspectors call it); safe
// because the tools are pure functions over the JSON in the request. Keep it on
// localhost or behind your own proxy/auth if exposed. PORT/HOST env vars are the
// fallbacks for the flags, for container platforms that inject PORT.

import { createFlattenHttpServer, MCP_PATH } from './http-core.js';
import { VERSION } from './version.js';

const USAGE = `flatten-mcp-http — in-memory flatten engine over MCP Streamable HTTP (stateless)

Usage:
  flatten-mcp-http [--port N] [--host H]

Options:
  --port N    Port to listen on (default: $PORT or 8787)
  --host H    Address to bind (default: $HOST or 127.0.0.1; 0.0.0.0 exposes it to the network)
  -h, --help  Show this help

Endpoint: POST ${MCP_PATH} (MCP Streamable HTTP). Tools: flatten_messages, unflatten_messages.`;

class UsageError extends Error {}

function parseHttpArgs(argv: string[]): { port: number; host: string; help: boolean } {
    let port = Number(process.env.PORT || 8787);
    let host = process.env.HOST || '127.0.0.1';
    let help = false;

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        const eq = token.startsWith('--') ? token.indexOf('=') : -1;
        const name = eq === -1 ? token : token.slice(0, eq);
        const take = (): string => {
            if (eq !== -1) return token.slice(eq + 1);
            const next = argv[++i];
            if (next === undefined) throw new UsageError(`${name} needs a value.`);
            return next;
        };
        switch (name) {
            case '-h':
            case '--help':
                help = true;
                break;
            case '--port': {
                const raw = take();
                port = Number(raw);
                if (raw.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
                    throw new UsageError(`--port needs an integer 0-65535, got: ${raw}`);
                }
                break;
            }
            case '--host':
                host = take();
                break;
            default:
                throw new UsageError(`unknown option: ${token}\n\n${USAGE}`);
        }
    }

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`PORT must be an integer 0-65535, got: ${process.env.PORT}`);
    }
    return { port, host, help };
}

function main(): void {
    let opts: ReturnType<typeof parseHttpArgs>;
    try {
        opts = parseHttpArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`flatten-mcp-http: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
    }
    if (opts.help) {
        process.stdout.write(USAGE + '\n');
        return;
    }

    const server = createFlattenHttpServer();
    server.on('error', (err: NodeJS.ErrnoException) => {
        process.stderr.write(`flatten-mcp-http: ${err.code === 'EADDRINUSE' ? `port ${opts.port} is already in use` : err.message}\n`);
        process.exit(1);
    });
    server.listen(opts.port, opts.host, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : opts.port;
        process.stdout.write(
            `flatten-mcp-http v${VERSION} listening on http://${opts.host}:${port}${MCP_PATH} (Streamable HTTP, stateless)\n` +
            `tools: flatten_messages, unflatten_messages — in-memory only, no disk, no outbound network\n` +
            (opts.host === '127.0.0.1' || opts.host === 'localhost'
                ? ''
                : `WARNING: bound to ${opts.host} with no auth — anyone who can reach this port can call the tools.\n`)
        );
    });

    const shutdown = (): void => {
        server.close(() => process.exit(0));
        // Close idle keep-alive connections too; force-exit if something hangs.
        server.closeAllConnections?.();
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
