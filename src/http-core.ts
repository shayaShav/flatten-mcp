// Streamable HTTP server core over the in-memory engine — the transport behind
// the flatten-mcp-http bin (http.ts holds the argv/lifecycle wiring so this stays
// unit-testable, the same split as cli.ts/cli-core.ts).
//
// Serves ONLY the stateless in-memory tools (flatten_messages/unflatten_messages,
// see inmemory-tools.ts). The disk tools are deliberately NOT exposed here: they
// read and rewrite the local Claude Code session store, which does not exist
// wherever a remote client is calling from — exposing them over HTTP would just
// produce dead tools. Local session work stays on the stdio server.
//
// Stateless per the SDK's canonical pattern: a fresh McpServer + transport pair
// per POST (sessionIdGenerator: undefined), so concurrent clients can never
// collide on request ids or session state. enableJsonResponse keeps responses
// plain application/json — curl-friendly, no SSE stream to parse.
//
// Security posture: no auth, permissive CORS (that is what lets browser-based
// registry inspectors call it). Acceptable because the tools are pure functions
// over caller-supplied JSON — no disk, no credentials, no outbound network, no
// state. Bind it to localhost (the bin's default) or put your own proxy in front
// if you expose it further.

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerInMemoryTools } from './inmemory-tools.js';
import { VERSION } from './version.js';

export const MCP_PATH = '/mcp';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'flatten-mcp-http', version: VERSION });
    registerInMemoryTools(server);
    return server;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Fresh pair per request (stateless mode) — torn down when the response closes.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
    } catch (err) {
        if (!res.headersSent) {
            writeJson(res, 500, {
                jsonrpc: '2.0',
                error: { code: -32603, message: `Internal server error: ${err instanceof Error ? err.message : String(err)}` },
                id: null,
            });
        }
    }
}

/**
 * Build the (not yet listening) node:http server. The caller decides where it
 * listens: the bin binds the CLI-chosen host/port, tests bind 127.0.0.1:0.
 *   POST /mcp          -> Streamable HTTP (stateless, JSON responses)
 *   GET|DELETE /mcp    -> 405 (no SSE stream and no session to delete in stateless mode)
 *   GET /              -> plain-JSON service info (human/health-check convenience)
 */
export function createFlattenHttpServer(): NodeHttpServer {
    return createServer((req, res) => {
        setCorsHeaders(res);
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method === 'OPTIONS') {
            res.writeHead(204).end();
            return;
        }

        if (url.pathname === MCP_PATH) {
            if (req.method === 'POST') {
                void handleMcpPost(req, res);
                return;
            }
            writeJson(res, 405, {
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Method not allowed. This stateless endpoint accepts POST only.' },
                id: null,
            });
            return;
        }

        if (url.pathname === '/' && req.method === 'GET') {
            writeJson(res, 200, {
                name: 'flatten-mcp-http',
                version: VERSION,
                transport: 'streamable-http',
                endpoint: MCP_PATH,
                tools: ['flatten_messages', 'unflatten_messages'],
            });
            return;
        }

        writeJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32000, message: `Not found. MCP endpoint is POST ${MCP_PATH}.` },
            id: null,
        });
    });
}
