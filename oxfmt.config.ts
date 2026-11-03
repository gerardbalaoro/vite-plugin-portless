import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "dist/**",
    ".test-artifacts/**",
    "pnpm-lock.yaml",
  ],
  printWidth: 100,
  proseWrap: "always",
});
