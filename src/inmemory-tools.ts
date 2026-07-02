// MCP tool surface over the in-memory engine (core.ts): flatten_messages /
// unflatten_messages operate on a raw Anthropic Messages API `messages[]` array
// carried in the tool call itself — no session file, no disk, no network. This is
// the registrar shared by the two places that expose it:
//   - the Streamable HTTP entry (http-core.ts), always — its whole purpose is to
//     make the engine callable from hosted registry inspectors and remote clients;
//   - the stdio server (index.ts), only when FLATTEN_INMEMORY_TOOLS=1 — by default
//     the local tool surface stays the three disk tools (tool schemas cost context
//     tokens on every turn, and the disk tools are the product).
//
// Transporting the conversation to a server moves the exact bulk the library API
// avoids moving (see docs/features/1-in-memory-flatten-api), so these tools are a
// demo/integration surface for the in-memory engine, not a replacement for
// `import { flattenMessages } from 'flatten-mcp'`.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    flattenMessages,
    unflattenMessages,
    type ApiMessage,
    type ExtractedEntry,
} from './core.js';

export function registerInMemoryTools(server: McpServer): void {
    server.tool(
        'flatten_messages',
        'Flatten a raw Anthropic Messages API messages[] array in memory: every bulky tool_result block (large text or base64 image) larger than min_size bytes is swapped for a compact [FLATTENED id=...] marker, and the originals are returned in "extracted". Persist "extracted" yourself — you are the store — and feed it back to unflatten_messages to restore the conversation byte-for-byte. Purely functional: no session file, no disk, no network; the input is never mutated. This is the same engine as the flatten-mcp library export; for production use inside your own process, prefer importing the library so the conversation does not travel over a transport.',
        {
            messages: z.array(z.record(z.unknown()))
                .describe('The raw Messages API messages[] array ({ role, content } objects, verbatim).'),
            min_size: z.number().optional().default(1000)
                .describe('Only flatten tool_result blocks larger than N serialized bytes.'),
        },
        async ({ messages, min_size }) => {
            const result = flattenMessages(messages as unknown as ApiMessage[], { minSize: min_size });
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
        }
    );

    server.tool(
        'unflatten_messages',
        'Restore a conversation flattened by flatten_messages: re-inlines every tool_result whose content is a [FLATTENED id=...] marker from the matching entry in "extracted", byte-for-byte. Markers with no matching entry are left in place. Purely functional — no disk, no network, input never mutated.',
        {
            messages: z.array(z.record(z.unknown()))
                .describe('The flattened messages[] array (the "messages" field of a flatten_messages result).'),
            extracted: z.array(z.record(z.unknown()))
                .describe('The "extracted" array returned by flatten_messages for this conversation.'),
        },
        async ({ messages, extracted }) => {
            const restored = unflattenMessages(
                messages as unknown as ApiMessage[],
                extracted as unknown as ExtractedEntry[]
            );
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ messages: restored }) }],
            };
        }
    );
}
