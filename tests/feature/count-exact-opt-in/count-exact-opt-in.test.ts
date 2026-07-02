import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { flattenSession } from '../../../src/flattener.js';
import { flattenMessagesExact, type ApiMessage } from '../../../src/core.js';

const SID = 'sess-optin';
const BIG = 'A'.repeat(4000);

// ─── Fixtures ────────────────────────────────────────────────────────

function sessionLines(): string[] {
    return [
        JSON.stringify({ type: 'user', sessionId: SID, uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'run a tool' } }),
        JSON.stringify({ type: 'assistant', sessionId: SID, uuid: 'u2', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }] } }),
        JSON.stringify({ type: 'user', sessionId: SID, uuid: 'u3', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: BIG }] } }),
    ];
}

function inMemoryConversation(): ApiMessage[] {
    return [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_m1', name: 'Read', input: { file_path: '/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m1', content: BIG }] },
    ];
}

/** fetch mock: first call (removed values) 5000 tokens, second (markers) 100. */
function countTokensFetchMock() {
    return vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ input_tokens: 5000 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ input_tokens: 100 }) });
}

describe('exact count_tokens requires explicit opt-in on the disk path (issue #12)', () => {
    let dir: string;
    let live: string;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flatten-optin-'));
        live = path.join(dir, `${SID}.jsonl`);
        await fs.writeFile(live, sessionLines().join('\n') + '\n', 'utf-8');
        fetchMock = countTokensFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        // Neutral baseline regardless of the developer machine's real env.
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        vi.stubEnv('FLATTEN_COUNT_EXACT', '');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('ANTHROPIC_API_KEY alone does NOT trigger the network call — savings stay estimated', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

        const r = await flattenSession(live, 1000, false, true);

        expect(r.flattenedCount).toBeGreaterThan(0);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(r.contextTokensExact).toBe(false);
        expect(r.contextTokensSaved).toBeGreaterThan(0); // local estimate still reported
    });

    it('FLATTEN_COUNT_EXACT=1 plus the key enables the exact count', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
        vi.stubEnv('FLATTEN_COUNT_EXACT', '1');

        const r = await flattenSession(live, 1000, false, true);

        expect(fetchMock).toHaveBeenCalledTimes(2); // removed values + markers
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages/count_tokens');
        expect(r.contextTokensExact).toBe(true);
        expect(r.contextTokensSaved).toBe(4900); // 5000 removed - 100 markers
    });

    it.each(['true', 'yes', 'on', 'TRUE'])('affirmative value %s is accepted', async (v) => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
        vi.stubEnv('FLATTEN_COUNT_EXACT', v);

        const r = await flattenSession(live, 1000, false, true);

        expect(fetchMock).toHaveBeenCalled();
        expect(r.contextTokensExact).toBe(true);
    });

    it.each(['0', 'false', 'no', 'off', ' '])('non-affirmative value %j stays offline', async (v) => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
        vi.stubEnv('FLATTEN_COUNT_EXACT', v);

        const r = await flattenSession(live, 1000, false, true);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(r.contextTokensExact).toBe(false);
    });

    it('the opt-in without a key stays offline (nothing to call with)', async () => {
        vi.stubEnv('FLATTEN_COUNT_EXACT', '1');

        const r = await flattenSession(live, 1000, false, true);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(r.contextTokensExact).toBe(false);
    });

    it('opted in but the API fails: falls back silently to the estimate', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
        vi.stubEnv('FLATTEN_COUNT_EXACT', '1');
        fetchMock.mockReset().mockResolvedValue({ ok: false, json: async () => ({}) });

        const r = await flattenSession(live, 1000, false, true);

        expect(fetchMock).toHaveBeenCalled();
        expect(r.contextTokensExact).toBe(false);
        expect(r.contextTokensSaved).toBeGreaterThan(0); // the estimate
    });

    it('library API is unaffected: flattenMessagesExact still counts on key + default countExact', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
        // FLATTEN_COUNT_EXACT deliberately NOT set — the env gate is disk-path only;
        // the library's explicit *Exact call + countExact param is its own opt-in.

        const r = await flattenMessagesExact(inMemoryConversation());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(r.contextTokensExact).toBe(true);
        expect(r.contextTokensSaved).toBe(4900);
    });
});
