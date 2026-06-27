import { describe, it, expect } from 'vitest';
// Import the REAL public entry point — the same module consumers import as
// `from 'flatten-mcp'`. Importing lib.ts also asserts the no-boot-hazard
// invariant: if lib.ts pulled in index.ts, this import would boot a stdio
// server and the suite would hang.
import {
    flattenMessages,
    flattenMessagesExact,
    unflattenMessages,
    flattenRequestBody,
    flattenRequestBodyExact,
    unflattenRequestBody,
    type ApiMessage,
    type ContentBlock,
    type MessagesRequestBody,
} from '../../../src/lib.js';

// A tiny 1x1 PNG, repeated to comfortably clear the default 1000-byte minSize.
const BIG_IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='.repeat(160);
const BIG_TEXT = 'x'.repeat(5000);
const SMALL_TEXT = 'tiny';

/**
 * Build a source0-shaped conversation: a raw Messages API messages[] array with
 * NO Claude Code line wrapper, NO toolUseResult mirror — exactly a pre-send
 * request body. Covers every block kind the round trip must preserve.
 */
function buildConversation(): ApiMessage[] {
    return [
        { role: 'user', content: 'Please run some tools.' },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'On it.' },
                { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/foo/bar.ts' } } as unknown as ContentBlock,
                { type: 'tool_use', id: 'tu_shot', name: 'Screenshot', input: { description: 'capture screen' } } as unknown as ContentBlock,
                { type: 'tool_use', id: 'tu_mixed', name: 'Inspect', input: {} } as unknown as ContentBlock,
                { type: 'tool_use', id: 'tu_small', name: 'Echo', input: {} } as unknown as ContentBlock,
            ],
        },
        {
            role: 'user',
            content: [
                // string content, bulky -> flattened
                { type: 'tool_result', tool_use_id: 'tu_read', content: BIG_TEXT, is_error: false },
                // image-only array content, bulky -> flattened
                {
                    type: 'tool_result',
                    tool_use_id: 'tu_shot',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_IMAGE_DATA } },
                    ],
                },
                // mixed text+image array content, bulky -> flattened, is_error preserved
                {
                    type: 'tool_result',
                    tool_use_id: 'tu_mixed',
                    content: [
                        { type: 'text', text: BIG_TEXT },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_IMAGE_DATA } },
                    ],
                    is_error: true,
                },
                // small string content -> left alone
                { type: 'tool_result', tool_use_id: 'tu_small', content: SMALL_TEXT },
            ],
        },
    ];
}

describe('flattenMessages / unflattenMessages', () => {
    it('1. flattens bulky tool_results and leaves small ones alone', () => {
        const result = flattenMessages(buildConversation());
        // tu_read, tu_shot, tu_mixed are bulky; tu_small is not.
        expect(result.flattenedCount).toBe(3);
        const ids = result.extracted.map(e => e.id).sort();
        expect(ids).toEqual(['tu_mixed', 'tu_read', 'tu_shot']);
        expect(ids).not.toContain('tu_small');

        // The small tool_result still carries its verbatim content.
        const userMsg = result.messages[2];
        const small = (userMsg.content as ContentBlock[]).find(b => b.tool_use_id === 'tu_small');
        expect(small?.content).toBe(SMALL_TEXT);
    });

    it('2. replaces content with markers whose ids match extracted entries', () => {
        const result = flattenMessages(buildConversation());
        const userMsg = result.messages[2];
        const blocks = userMsg.content as ContentBlock[];

        const markerIds: string[] = [];
        for (const b of blocks) {
            if (b.tool_use_id === 'tu_small') continue;
            expect(typeof b.content).toBe('string');
            const m = (b.content as string).match(/^\[FLATTENED id=(\S+)\s/);
            expect(m, `block ${b.tool_use_id} should be a marker`).not.toBeNull();
            markerIds.push(m![1]);
        }
        expect(markerIds.sort()).toEqual(result.extracted.map(e => e.id).sort());
    });

    it('3. round-trips every block kind byte-identically (incl. is_error)', () => {
        const original = buildConversation();
        const { messages: flattened, extracted } = flattenMessages(original);
        const restored = unflattenMessages(flattened, extracted);
        expect(restored).toEqual(original);
    });

    it('4. preserves base64 image data and media_type exactly', () => {
        const original = buildConversation();
        const { messages: flattened, extracted } = flattenMessages(original);
        const restored = unflattenMessages(flattened, extracted);

        const shotBlock = (restored[2].content as ContentBlock[]).find(b => b.tool_use_id === 'tu_shot');
        const imgBlock = (shotBlock!.content as ContentBlock[])[0];
        expect(imgBlock.source?.data).toBe(BIG_IMAGE_DATA);
        expect(imgBlock.source?.data?.length).toBe(BIG_IMAGE_DATA.length);
        expect(imgBlock.source?.media_type).toBe('image/png');
    });

    it('5. does not mutate the caller input array (deep-copy invariant)', () => {
        const original = buildConversation();
        const snapshot = structuredClone(original);
        flattenMessages(original);
        expect(original).toEqual(snapshot);
    });

    it('6. no-tool_result body -> nothing flattened, output deep-equals input', () => {
        const messages: ApiMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        ];
        const result = flattenMessages(messages);
        expect(result.flattenedCount).toBe(0);
        expect(result.extracted).toEqual([]);
        expect(result.messages).toEqual(messages);
    });

    it('7. reports metrics: contextTokensSaved > 0, counts images, exact flag false', () => {
        const result = flattenMessages(buildConversation());
        expect(result.contextTokensSaved).toBeGreaterThan(0);
        // tu_shot has one image, tu_mixed has one image => 2 image blocks.
        expect(result.imageBlocksFlattened).toBe(2);
        // Sync variant never counts exactly.
        expect(result.contextTokensExact).toBe(false);
    });

    it('bonus: respects a custom minSize', () => {
        // With a huge minSize nothing should flatten.
        const high = flattenMessages(buildConversation(), { minSize: 10_000_000 });
        expect(high.flattenedCount).toBe(0);
        // With a tiny minSize even the small result flattens.
        const low = flattenMessages(buildConversation(), { minSize: 1 });
        expect(low.flattenedCount).toBe(4);
    });

    it('bonus: idempotent — re-flattening an already-flattened body is a no-op', () => {
        const { messages: once } = flattenMessages(buildConversation());
        const twice = flattenMessages(once);
        expect(twice.flattenedCount).toBe(0);
        expect(twice.messages).toEqual(once);
    });

    it('bonus: a tool_use input with an undefined-valued field does not throw', () => {
        // Raw-API callers routinely leave optional fields undefined; the marker
        // summary must not crash on them. (`path` is a summarized key arg.)
        const messages: ApiMessage[] = [
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tu_u', name: 'Grep', input: { pattern: 'foo', path: undefined } } as unknown as ContentBlock,
                ],
            },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_u', content: BIG_TEXT }] },
        ];
        let result!: ReturnType<typeof flattenMessages>;
        expect(() => { result = flattenMessages(messages); }).not.toThrow();
        expect(result.flattenedCount).toBe(1);
        const marker = (result.messages[1].content as ContentBlock[])[0].content as string;
        expect(marker.startsWith('[FLATTENED id=tu_u tool=Grep')).toBe(true);
    });

    it('bonus: unflatten leaves a marker with no matching extracted entry in place', () => {
        const { messages: flattened, extracted } = flattenMessages(buildConversation());
        // Drop tu_read's original so its marker has no restore source.
        const partial = extracted.filter(e => e.id !== 'tu_read');
        const restored = unflattenMessages(flattened, partial);
        const blocks = restored[2].content as ContentBlock[];
        const readBlock = blocks.find(b => b.tool_use_id === 'tu_read');
        expect(typeof readBlock!.content).toBe('string');
        expect((readBlock!.content as string).startsWith('[FLATTENED id=tu_read')).toBe(true);
        // The others still restore normally.
        const shotBlock = blocks.find(b => b.tool_use_id === 'tu_shot');
        expect(Array.isArray(shotBlock!.content)).toBe(true);
    });

    it('bonus: unflatten uses the last entry when extracted has duplicate ids', () => {
        const { messages: flattened, extracted } = flattenMessages(buildConversation());
        const readEntry = extracted.find(e => e.id === 'tu_read')!;
        const withDup = [...extracted, { ...readEntry, content: 'OVERRIDDEN' }];
        const restored = unflattenMessages(flattened, withDup);
        const readBlock = (restored[2].content as ContentBlock[]).find(b => b.tool_use_id === 'tu_read');
        expect(readBlock!.content).toBe('OVERRIDDEN');
    });
});

describe('flattenMessagesExact (async, dual API)', () => {
    // countExact:false keeps these deterministic and offline regardless of
    // whether ANTHROPIC_API_KEY happens to be set in the environment.
    it('with countExact:false, flattens identically to the sync variant and reports the estimate', async () => {
        const sync = flattenMessages(buildConversation());
        const exact = await flattenMessagesExact(buildConversation(), { countExact: false });
        expect(exact.flattenedCount).toBe(sync.flattenedCount);
        expect(exact.contextTokensSaved).toBe(sync.contextTokensSaved);
        expect(exact.contextTokensExact).toBe(false);
        expect(exact.messages).toEqual(sync.messages);
    });

    it('round-trips losslessly', async () => {
        const original = buildConversation();
        const { messages, extracted } = await flattenMessagesExact(original, { countExact: false });
        expect(unflattenMessages(messages, extracted)).toEqual(original);
    });
});

describe('whole-body request wrappers', () => {
    function buildBody(): MessagesRequestBody {
        return {
            model: 'claude-opus-4-8',
            max_tokens: 1024,
            system: 'You are a helpful assistant.',
            tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
            messages: buildConversation(),
        };
    }

    it('flattens only messages; passes system/tools/model/max_tokens through untouched', () => {
        const body = buildBody();
        const { body: out, flattenedCount, contextTokensExact } = flattenRequestBody(body);
        expect(flattenedCount).toBe(3);
        expect(contextTokensExact).toBe(false);
        expect(out.system).toBe(body.system);
        expect(out.tools).toEqual(body.tools);
        expect(out.model).toBe('claude-opus-4-8');
        expect(out.max_tokens).toBe(1024);
        // messages really were flattened (first tool_result is now a marker string)
        const blocks = (out.messages as ApiMessage[])[2].content as ContentBlock[];
        expect(typeof blocks[0].content).toBe('string');
        expect((blocks[0].content as string).startsWith('[FLATTENED id=')).toBe(true);
    });

    it('does not mutate the input body or its messages', () => {
        const body = buildBody();
        const snapshot = structuredClone(body);
        flattenRequestBody(body);
        expect(body).toEqual(snapshot);
    });

    it('round-trips the whole body losslessly', () => {
        const body = buildBody();
        const { body: flat, extracted } = flattenRequestBody(body);
        const restored = unflattenRequestBody(flat, extracted);
        expect(restored).toEqual(body);
    });

    it('exact body variant (countExact:false) matches the sync body wrapper', async () => {
        const body = buildBody();
        const sync = flattenRequestBody(body);
        const exact = await flattenRequestBodyExact(body, { countExact: false });
        expect(exact.body).toEqual(sync.body);
        expect(exact.contextTokensExact).toBe(false);
    });
});
