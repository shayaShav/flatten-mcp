import { describe, it, expect } from 'vitest';
// Pure argument core of the flatten-mcp-session bin (no process side effects).
import { parseArgs, resolvePositionals, UsageError } from '../../../src/session-cli-core.js';
import { isSafeSessionId } from '../../../src/session-store.js';

describe('session CLI positional handling', () => {
    it('merges the unquoted two-token "last N" selector into one', () => {
        expect(resolvePositionals('flatten', ['last', '5'], 1)).toEqual(['last 5']);
    });

    it('keeps the quoted single-token "last N" form as-is', () => {
        expect(resolvePositionals('flatten', ['last 5'], 1)).toEqual(['last 5']);
    });

    it('merges "last N" ahead of arity for retrieve', () => {
        expect(resolvePositionals('retrieve', ['last', '2', 'tu_x'], 2)).toEqual(['last 2', 'tu_x']);
    });

    it('hard-errors on unexpected extra positionals instead of ignoring them', () => {
        expect(() => resolvePositionals('flatten', ['abc', 'def'], 1)).toThrow(UsageError);
        expect(() => resolvePositionals('list', ['extra'], 0)).toThrow(UsageError);
        expect(() => resolvePositionals('retrieve', ['sid', 'tool', 'extra'], 2)).toThrow(UsageError);
    });

    it('leaves valid arities untouched', () => {
        expect(resolvePositionals('flatten', [], 1)).toEqual([]);
        expect(resolvePositionals('unflatten', ['last'], 1)).toEqual(['last']);
    });

    it('parseArgs separates flags from positionals', () => {
        const a = parseArgs(['last', '5', '--dry-run', '--min-size', '2000']);
        expect(a.positionals).toEqual(['last', '5']);
        expect(a.dryRun).toBe(true);
        expect(a.minSize).toBe(2000);
    });
});

describe('isSafeSessionId (retrieve_flattened path guard)', () => {
    it('accepts UUID-shaped ids', () => {
        expect(isSafeSessionId('2f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b')).toBe(true);
        expect(isSafeSessionId('toolu_01AbC')).toBe(true);
    });

    it('rejects traversal segments, separators, and empty input', () => {
        expect(isSafeSessionId('../other')).toBe(false);
        expect(isSafeSessionId('a/b')).toBe(false);
        expect(isSafeSessionId('a\\b')).toBe(false);
        expect(isSafeSessionId('..')).toBe(false);
        expect(isSafeSessionId('')).toBe(false);
    });
});
