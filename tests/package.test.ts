import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { execute } from "./processes.js";

describe("published package", () => {
  it("loads its public export and declarations from a packed artifact", async () => {
    const consumer = await mkdtemp(path.join(tmpdir(), "portless-package-"));

    try {
      const archive = path.join(consumer, "plugin.tgz");
      await execute("pnpm", ["pack", "--out", archive], { shell: process.platform === "win32" });
      await execute("tar", ["-xzf", archive, "-C", consumer]);
      await mkdir(path.join(consumer, "node_modules"));
      await symlink(
        path.join(consumer, "package"),
        path.join(consumer, "node_modules", "vite-plugin-portless"),
        "junction"
      );
      await Promise.all(
        ["open", "picocolors", "@types"].map(async (dependency) => {
          await symlink(
            path.resolve("node_modules", dependency),
            path.join(consumer, "node_modules", dependency),
            "junction"
          );
        })
      );
      await symlink(
        path.resolve("node_modules", process.env.VITE_TEST_PACKAGE ?? "vite"),
        path.join(consumer, "node_modules", "vite"),
        "junction"
      );
      await writeFile(path.join(consumer, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(consumer, "consumer.ts"),
        'import { portless } from "vite-plugin-portless"; import type { Plugin } from "vite"; const plugin: Plugin = portless(); console.log(plugin.name);'
      );

      const result = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { portless } from "vite-plugin-portless"; console.log(portless().name);',
        ],
        { cwd: consumer }
      );

      const compiler = path.join(
        path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
        "bin",
        "tsc"
      );

      const types = await execute(
        process.execPath,
        [
          compiler,
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2024",
          "--module",
          "NodeNext",
          "--types",
          "node",
          "consumer.ts",
        ],
        { cwd: consumer }
      );

      expect(result.stdout.trim()).toBe("vite-plugin-portless");
      expect(types.stdout).toBe("");
    } finally {
      await rm(consumer, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  });
});
