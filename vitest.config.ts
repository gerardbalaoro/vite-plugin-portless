import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      vite: fileURLToPath(import.meta.resolve(process.env.VITE_TEST_PACKAGE ?? "vite")),
    },
    fileParallelism: false,
    hookTimeout: 30_000,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
