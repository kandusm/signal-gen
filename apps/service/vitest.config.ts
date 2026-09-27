import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the contract package to its SOURCE in tests.
      //
      // Two reasons. A fresh clone has no packages/contract/dist yet, so
      // resolving through package.json main would fail before anything is
      // built. And once it is built, tests would silently run against a stale
      // dist after any contract edit -- exactly the drift this package exists
      // to prevent. Production code still resolves the built output.
      '@signalgen/contract': resolve(__dirname, '../../packages/contract/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
  },
});
