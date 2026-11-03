import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: { node: true },
  extends: [core, antiSlop, vitest],
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**", ".test-artifacts/**"],
});
