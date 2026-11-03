import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: { node: true },
  extends: [core, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**", ".test-artifacts/**"],
});
