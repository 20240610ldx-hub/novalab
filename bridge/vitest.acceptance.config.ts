import { defineConfig } from 'vitest/config';

/** Real Bridge/kernel processes require the prepared Python environment. */
export default defineConfig({
  test: {
    include: ['src/*.acceptance.ts'],
    fileParallelism: false,
  },
});
