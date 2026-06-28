import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
// The Claude Code disk adapter — the single-self-syncing-backup model.
import { flattenSession, unflattenSession, retrieveFlattened } from '../../../src/flattener.js';

const SID = 'sess-test';
const BIG = 'A'.repeat(4000);     // tool_result content, > min_size
const BIG2 = 'B'.repeat(4000);    // a second turn's bulk
const MIRROR = 'M'.repeat(4000);  // the toolUseResult mirror, > min_size

// ─── Fixture builders (raw Claude Code session JSONL lines) ──────────

function userText(content: string, uuid: string): string {
    return JSON.stringify({ type: 'user', sessionId: SID, uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content } });
}
function assistantToolUse(id: string, name: string, input: Record<string, unknown>, uuid: string): string {
    return JSON.stringify({ type: 'assistant', sessionId: SID, uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
}
function userToolResult(toolUseId: string, content: unknown, uuid: string, toolUseResult?: unknown): string {
    const obj: Record<string, unknown> = {
        type: 'user', sessionId: SID, uuid, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    };
    if (toolUseResult !== undefined) obj.toolUseResult = toolUseResult;
    return JSON.stringify(obj);
}

/** Base session: one Read whose result (and its mirror) are both bulky. */
function baseSession(): string[] {
    return [
        userText('run a tool', 'u1'),
        assistantToolUse('toolu_1', 'Read', { file_path: '/a.ts' }, 'u2'),
        userToolResult('toolu_1', BIG, 'u3', MIRROR),
    ];
}

async function readJsonl(p: string): Promise<Array<Record<string, any>>> {
    const c = await fs.readFile(p, 'utf-8');
    return c.trimEnd().split('\n').map(l => JSON.parse(l));
}
async function exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
}

describe('disk adapter — self-cleaning single backup', () => {
    let dir: string;
    let live: string;
    let backup: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flatten-test-'));
        live = path.join(dir, `${SID}.jsonl`);
        backup = `${live}.bak`;
        await fs.writeFile(live, baseSession().join('\n') + '\n', 'utf-8');
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('first flatten writes ONE backup — no sidecar, no preunflatten snapshot', async () => {
        const r = await flattenSession(live, 1000, false, true);

        expect(r.flattenedCount).toBe(2); // tool_result content + toolUseResult mirror
        expect(r.backupPath).toBe(backup);
        expect(await exists(backup)).toBe(true);
        // The artifacts the old model produced must NOT exist.
        expect(await exists(path.join(dir, `${SID}.flat.jsonl`))).toBe(false);
        expect(await exists(`${live}.preunflatten.bak`)).toBe(false);

        // Live file now carries markers in both slots.
        const lines = await readJsonl(live);
        expect((lines[2].message.content[0].content as string).startsWith('[FLATTENED id=toolu_1 ')).toBe(true);
        expect((lines[2].toolUseResult as string).startsWith('[FLATTENED id=toolu_1#tur ')).toBe(true);

        // First flatten: the backup is the complete, pristine original (no markers).
        const b = await readJsonl(backup);
        expect(b[2].message.content[0].content).toBe(BIG);
        expect(b[2].toolUseResult).toBe(MIRROR);
    });

    it('dry run reports the count but writes nothing', async () => {
        const r = await flattenSession(live, 1000, true, true);
        expect(r.flattenedCount).toBe(2);
        expect(await exists(backup)).toBe(false);
        const lines = await readJsonl(live);
        expect(lines[2].message.content[0].content).toBe(BIG); // still inline
    });

    it('retrieve returns the original content and mirror straight from the backup', async () => {
        await flattenSession(live, 1000, false, true);

        const got = await retrieveFlattened(backup, 'toolu_1');
        expect(got.content).toBe(BIG);
        expect(got.tool_name).toBe('Read');
        expect(got.slot).toBe('content');

        const mir = await retrieveFlattened(backup, 'toolu_1#tur');
        expect(mir.content).toBe(MIRROR);
        expect(mir.slot).toBe('toolUseResult');
    });

    it('retrieve throws a helpful error for an unknown id', async () => {
        await flattenSession(live, 1000, false, true);
        await expect(retrieveFlattened(backup, 'nope')).rejects.toThrow(/not found in backup/);
    });

    it('unflatten restores the live file AND deletes the backup (zero artifacts)', async () => {
        await flattenSession(live, 1000, false, true);
        const r = await unflattenSession(live, backup);

        expect(r.restoredCount).toBe(2);
        expect(r.notFound).toEqual([]);
        expect(await exists(backup)).toBe(false); // self-cleaned

        const lines = await readJsonl(live);
        expect(lines[2].message.content[0].content).toBe(BIG);
        expect(lines[2].toolUseResult).toBe(MIRROR);
    });

    it('flatten -> unflatten round-trips value-faithfully', async () => {
        const before = await readJsonl(live);
        await flattenSession(live, 1000, false, true);
        await unflattenSession(live, backup);
        const after = await readJsonl(live);
        expect(after).toEqual(before);
    });

    it('unflatten preserves content appended AFTER the flatten (no blind copy-over)', async () => {
        await flattenSession(live, 1000, false, true);

        // The session keeps going: a brand-new raw turn lands after flattening,
        // present in the live file but not yet in the backup.
        const grown = (await fs.readFile(live, 'utf-8')).trimEnd().split('\n');
        grown.push(assistantToolUse('toolu_2', 'Bash', { command: 'ls' }, 'u4'));
        grown.push(userToolResult('toolu_2', BIG2, 'u5'));
        await fs.writeFile(live, grown.join('\n') + '\n', 'utf-8');

        const r = await unflattenSession(live, backup);
        expect(r.restoredCount).toBe(2); // toolu_1 content + mirror
        const lines = await readJsonl(live);
        expect(lines[2].message.content[0].content).toBe(BIG);  // restored from backup
        expect(lines[4].message.content[0].content).toBe(BIG2); // newer turn survived
        expect(await exists(backup)).toBe(false);
    });

    it('live re-flatten keeps the backup complete for every turn', async () => {
        await flattenSession(live, 1000, false, true);

        // Grow the session with new bulk, then flatten again.
        const grown = (await fs.readFile(live, 'utf-8')).trimEnd().split('\n');
        grown.push(assistantToolUse('toolu_2', 'Bash', { command: 'ls' }, 'u4'));
        grown.push(userToolResult('toolu_2', BIG2, 'u5'));
        await fs.writeFile(live, grown.join('\n') + '\n', 'utf-8');

        const r2 = await flattenSession(live, 1000, false, true);
        expect(r2.flattenedCount).toBe(1); // only the newly-arrived bulk (turn 1 is already markers)

        // The re-synced backup holds BOTH originals — old and new.
        expect((await retrieveFlattened(backup, 'toolu_1')).content).toBe(BIG);
        expect((await retrieveFlattened(backup, 'toolu_2')).content).toBe(BIG2);

        // A full unflatten restores both turns, then self-cleans.
        const u = await unflattenSession(live, backup);
        expect(u.notFound).toEqual([]);
        const lines = await readJsonl(live);
        expect(lines[2].message.content[0].content).toBe(BIG);
        expect(lines[4].message.content[0].content).toBe(BIG2);
        expect(await exists(backup)).toBe(false);
    });

    it('flattens a base64 image tool_result and retrieve returns the image block', async () => {
        const imgData = 'Zm9v'.repeat(400); // bulky base64
        const imageBlock = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } }];
        const imgLive = path.join(dir, 'img.jsonl');
        await fs.writeFile(imgLive, [
            userText('take a screenshot', 'i1'),
            assistantToolUse('toolu_img', 'Screenshot', {}, 'i2'),
            userToolResult('toolu_img', imageBlock, 'i3'),
        ].join('\n') + '\n', 'utf-8');

        const r = await flattenSession(imgLive, 1000, false, true);
        expect(r.imageBlocksFlattened).toBe(1);

        const got = await retrieveFlattened(`${imgLive}.bak`, 'toolu_img');
        expect(got.kind).toBe('image');
        expect((got.content as Array<{ source: { data: string } }>)[0].source.data).toBe(imgData);
    });

    it('unflatten with no backup is a safe no-op', async () => {
        const r = await unflattenSession(live, backup); // never flattened
        expect(r.restoredCount).toBe(0);
        expect(r.skipped).toMatch(/No backup found/);
        const lines = await readJsonl(live);
        expect(lines[2].message.content[0].content).toBe(BIG); // untouched
    });
});
