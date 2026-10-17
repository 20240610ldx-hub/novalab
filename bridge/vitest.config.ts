import { defineConfig } from 'vitest/config';

/** Unit tests: every run gets its own temp root, removed at teardown (see src/testing/temp-sandbox.ts). */
export default defineConfig({
  test: {
    globalSetup: ['src/testing/temp-sandbox.ts'],
  },
});
