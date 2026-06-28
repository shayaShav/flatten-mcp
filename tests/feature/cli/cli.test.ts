import { describe, it, expect } from 'vitest';
// Import the pure CLI core (no process side effects), the same logic the
// `flatten-mcp-cli` bin wires stdin/stdout to.
import { runFlattenCli, CliUsageError } from '../../../src/cli-core.js';
import type { ApiMessage, ContentBlock } from '../../../src/lib.js';

const BIG_TEXT = 'x'.repeat(5000);

/** A raw Messages API messages[] body with one bulky tool_result. */
function buildConversation(): ApiMessage[] {
    return [
        { role: 'user', content: 'run a tool' },
        {
            role: 'assistant',
            content: [
                { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/a.ts' } } as unknown as ContentBlock,
            ],
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'tu_read', content: BIG_TEXT },
            ],
        },
    ];
}

describe('runFlattenCli (stdin/stdout CLI core)', () => {
    it('flattens a bare messages[] array from stdin', () => {
        const out = JSON.parse(runFlattenCli(['--flatten'], JSON.stringify(buildConversation())));
        expect(out.flattenedCount).toBe(1);
        expect(out.extracted).toHaveLength(1);
        const marker = (out.messages[2].content[0].content as string);
        expect(marker.startsWith('[FLATTENED id=tu_read')).toBe(true);
    });

    it('round-trips flatten -> unflatten byte-for-byte through the CLI', () => {
        const original = buildConversation();
        // The --flatten output ({messages, extracted, ...}) is fed straight to --unflatten.
        const flattened = runFlattenCli(['--flatten'], JSON.stringify(original));
        const restored = JSON.parse(runFlattenCli(['--unflatten'], flattened));
        expect(restored.messages).toEqual(original);
    });

    it('accepts the { messages } object form and honors --min-size', () => {
        // A huge min-size leaves the bulky result inline.
        const out = JSON.parse(
            runFlattenCli(['--flatten', '--min-size', '10000000'], JSON.stringify({ messages: buildConversation() }))
        );
        expect(out.flattenedCount).toBe(0);
    });

    it('rejects bad usage and bad input with CliUsageError', () => {
        expect(() => runFlattenCli([], '[]')).toThrow(CliUsageError);                    // no mode
        expect(() => runFlattenCli(['--flatten', '--unflatten'], '[]')).toThrow(CliUsageError); // both modes
        expect(() => runFlattenCli(['--flatten'], 'not json')).toThrow(CliUsageError);   // bad JSON
        expect(() => runFlattenCli(['--flatten'], '   ')).toThrow(CliUsageError);        // empty stdin
        expect(() => runFlattenCli(['--unflatten'], '{"messages":[]}')).toThrow(CliUsageError); // missing extracted
    });
});
