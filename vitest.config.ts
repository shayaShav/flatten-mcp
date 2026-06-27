import { defineConfig } from 'vitest/config';

// Minimal config. The default include glob picks up tests/**/*.test.ts, and
// tests/ sits outside the tsc `include` (src/**/*) so `npm run build` ignores it.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
