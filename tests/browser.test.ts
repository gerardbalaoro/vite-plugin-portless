import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeBrowserProcess, openPreviewBrowser } from "../src/browser.js";

describe(openPreviewBrowser, () => {
  let root = "";
  let errors: string[] = [];
  let logger = createLogger();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "portless-browser-"));
    errors = [];
    logger = createLogger();
    logger.error = (message) => {
      errors.push(message);
    };

    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      path.join(root, "capture.js"),
      'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TEST_BROWSER_LOG, process.argv.slice(2).join("\\n"));'
    );
    vi.stubEnv("TEST_BROWSER_LOG", path.join(root, "browser.log"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  });

  it("respects BROWSER=none", async () => {
    vi.stubEnv("BROWSER", "none");
    await openPreviewBrowser("https://app.localhost/", logger);

    expect(errors).toStrictEqual([]);
    await expect(readFile(path.join(root, "browser.log"))).rejects.toThrow("ENOENT");
  });

  // macOS launches application bundles rather than arbitrary executables through open -a.
  it.runIf(process.platform !== "darwin")(
    "passes BROWSER_ARGS to an actual browser executable",
    async () => {
      vi.stubEnv("BROWSER", process.execPath);
      vi.stubEnv("BROWSER_ARGS", `${path.join(root, "capture.js")} --new-window`);
      await openPreviewBrowser("https://app.localhost/", logger);
      await vi.waitFor(async () => {
        await expect(readFile(path.join(root, "browser.log"), "utf-8")).resolves.toBe(
          "--new-window\nhttps://app.localhost/"
        );
      });
      expect(errors).toStrictEqual([]);
    }
  );

  it("reports browser script failures through the existing logger", async () => {
    await writeFile(path.join(root, "failure.js"), "process.exitCode = 3;");
    vi.stubEnv("BROWSER", path.join(root, "failure.js"));
    await openPreviewBrowser("https://app.localhost/", logger);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toContain("exited with code 3");
  });

  it("reports a missing executable through the existing logger", async () => {
    vi.stubEnv("BROWSER", path.join(root, "missing-browser"));
    await openPreviewBrowser("https://app.localhost/", logger);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });

    expect(errors[0]).toMatch(/ENOENT|not found|cannot find|could not|does not exist/iu);
  });

  it.for([
    { code: 0, expected: [] },
    { code: 7, expected: ["Could not open browser test exited with code 7."] },
  ])("handles a launcher that already exited with code $code", async ({ code, expected }) => {
    const child = spawn(process.execPath, ["-e", `process.exitCode = ${code};`], {
      stdio: "ignore",
    });

    await once(child, "close");
    observeBrowserProcess(child, logger, "Could not open browser test");

    expect(errors).toStrictEqual(expected);
  });

  it("reports a spawn error only once when the child also emits close", async () => {
    const child = spawn(path.join(root, "missing-browser"), [], { stdio: "ignore" });
    const closed = Promise.withResolvers<undefined>();
    child.once("close", () => {
      closed.resolve(undefined);
    });
    observeBrowserProcess(child, logger, "Could not open browser test");
    await closed.promise;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ENOENT");
  });
});
