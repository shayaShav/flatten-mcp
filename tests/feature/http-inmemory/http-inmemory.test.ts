import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as NodeHttpServer } from 'node:http';
import { createFlattenHttpServer, MCP_PATH } from '../../../src/http-core.js';
import type { ApiMessage } from '../../../src/core.js';

const BIG = 'X'.repeat(5000);

function conversation(): ApiMessage[] {
    return [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_h1', name: 'Read', input: { file_path: '/big.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_h1', content: BIG }] },
    ];
}

describe('flatten-mcp-http — stateless Streamable HTTP over the in-memory engine', () => {
    let server: NodeHttpServer;
    let base: string;

    beforeAll(async () => {
        server = createFlattenHttpServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        if (typeof addr !== 'object' || addr === null) throw new Error('no address');
        base = `http://127.0.0.1:${addr.port}`;
    });
    afterAll(async () => {
        await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    });

    async function rpc(body: unknown): Promise<{ status: number; json: any }> {
        const res = await fetch(`${base}${MCP_PATH}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
    }

    async function callTool(id: number, name: string, args: unknown): Promise<any> {
        const { status, json } = await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
        expect(status).toBe(200);
        expect(json.error).toBeUndefined();
        return JSON.parse(json.result.content[0].text);
    }

    it('GET / returns service info', async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        const info = await res.json();
        expect(info.name).toBe('flatten-mcp-http');
        expect(info.endpoint).toBe(MCP_PATH);
        expect(info.tools).toEqual(['flatten_messages', 'unflatten_messages']);
    });

    it('initialize handshake succeeds and identifies the server', async () => {
        const { status, json } = await rpc({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vitest', version: '0.0.0' } },
        });
        expect(status).toBe(200);
        expect(json.result.serverInfo.name).toBe('flatten-mcp-http');
    });

    it('tools/list works without a prior initialize on the connection (stateless)', async () => {
        const { status, json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(status).toBe(200);
        const names = json.result.tools.map((t: { name: string }) => t.name).sort();
        expect(names).toEqual(['flatten_messages', 'unflatten_messages']);
    });

    it('flatten_messages -> unflatten_messages round-trips byte-identically over the wire', async () => {
        const flat = await callTool(3, 'flatten_messages', { messages: conversation() });

        expect(flat.flattenedCount).toBe(1);
        expect(flat.extracted).toHaveLength(1);
        expect(flat.extracted[0].id).toBe('toolu_h1');
        expect(flat.extracted[0].content).toBe(BIG);
        expect(flat.contextTokensSaved).toBeGreaterThan(0);
        expect(flat.contextTokensExact).toBe(false); // sync engine — never a network call
        const marker = flat.messages[2].content[0].content;
        expect(marker).toMatch(/^\[FLATTENED id=toolu_h1 /);

        const restored = await callTool(4, 'unflatten_messages', { messages: flat.messages, extracted: flat.extracted });
        expect(restored.messages[2].content[0].content).toBe(BIG);
        expect(restored.messages).toEqual(conversation());
    });

    it('min_size is honored', async () => {
        const flat = await callTool(5, 'flatten_messages', { messages: conversation(), min_size: 10000 });
        expect(flat.flattenedCount).toBe(0);
        expect(flat.messages).toEqual(conversation());
    });

    it('GET /mcp is 405, unknown paths are 404, OPTIONS preflight is 204 with CORS', async () => {
        const get = await fetch(`${base}${MCP_PATH}`, { headers: { accept: 'application/json, text/event-stream' } });
        expect(get.status).toBe(405);

        const nope = await fetch(`${base}/nope`);
        expect(nope.status).toBe(404);

        const preflight = await fetch(`${base}${MCP_PATH}`, { method: 'OPTIONS', headers: { origin: 'https://example.com' } });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    });
});
