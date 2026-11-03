import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunningCommand } from "./processes.js";
import { execute, freePort, startCommand, stopCommand } from "./processes.js";

const viteEntry = fileURLToPath(
  import.meta.resolve(`${process.env.VITE_TEST_PACKAGE ?? "vite"}/package.json`)
);

const viteBin = path.join(path.dirname(viteEntry), "bin", "vite.js");
const pluginUrl = pathToFileURL(path.resolve("dist/index.js")).href;
const yarnBin = fileURLToPath(import.meta.resolve("yarn-classic/bin/yarn.js"));

const environment = () => ({
  ...process.env,
  BROWSER: "none",
  CI: "1",
  FORCE_COLOR: "0",
  PORTLESS_LAN: "",
  PORTLESS_TAILSCALE_URL: "https://machine.tailnet.ts.net:8443",
  PORTLESS_URL: "https://app.localhost",
});

describe("CLI and package scripts", () => {
  let root = "";
  let commands: RunningCommand[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "portless-cli-"));
    commands = [];
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "index.html"), "<h1>Source fixture</h1>");
    await writeFile(path.join(root, "dist", "index.html"), "<h1>Preview fixture</h1>");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "portless-cli-fixture",
        private: true,
        scripts: { dev: "node vite-cli.mjs", preview: "node vite-cli.mjs preview" },
        type: "module",
      })
    );
    await writeFile(
      path.join(root, "vite-cli.mjs"),
      `import ${JSON.stringify(pathToFileURL(viteBin).href)};`
    );
    await writeFile(
      path.join(root, "vite.config.mjs"),
      `import { portless } from ${JSON.stringify(pluginUrl)}; export default { plugins: [portless()] };`
    );
  });

  afterEach(async () => {
    await Promise.all(
      commands.map(async ({ child }) => {
        await stopCommand(child);
      })
    );
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  });

  const launch = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = environment(),
    readyText = "https://machine.tailnet.ts.net:8443/"
  ) => {
    const running = startCommand(
      command,
      args,
      { cwd: root, env, shell: process.platform === "win32" && command !== process.execPath },
      readyText
    );

    commands.push(running);

    return running;
  };

  it.for(["development", "preview"])(
    "shows all supplied URLs through the direct Vite CLI: %s",
    async (mode) => {
      const port = String(await freePort());

      const args = [
        viteBin,
        ...(mode === "preview" ? ["preview"] : []),
        "--host",
        "127.0.0.1",
        "--port",
        port,
        "--strictPort",
      ];

      const running = launch(process.execPath, args);
      await running.ready;

      expect(running.output()).toContain(
        `  ➜  Local:   http://127.0.0.1:${port}/\n              https://app.localhost/`
      );
      expect(running.output()).toContain("  ➜  Network: https://machine.tailnet.ts.net:8443/");
      await expect(
        fetch(`http://127.0.0.1:${port}/`).then(async (response) => await response.text())
      ).resolves.toContain("fixture");
    }
  );

  it.for([
    { manager: "npm", mode: "dev" },
    { manager: "npm", mode: "preview" },
    { manager: "pnpm", mode: "dev" },
    { manager: "pnpm", mode: "preview" },
    { manager: "yarn", mode: "dev" },
    { manager: "yarn", mode: "preview" },
    { manager: "bun", mode: "dev" },
    { manager: "bun", mode: "preview" },
  ])("inherits URLs through $manager run $mode", async ({ manager, mode }) => {
    const args = ["run", mode];

    if (manager === "npm") {
      args.push("--");
    }

    args.push("--host", "127.0.0.1", "--port", String(await freePort()), "--strictPort");

    const running =
      manager === "yarn" ? launch(process.execPath, [yarnBin, ...args]) : launch(manager, args);

    await running.ready;

    expect(running.output()).toContain("https://app.localhost/");
    expect(running.output()).toContain("https://machine.tailnet.ts.net:8443/");
    expect(running.output().match(/Local:/gu)).toHaveLength(1);
  });

  it("keeps the native missing-build preview error outside Portless", async () => {
    await rm(path.join(root, "dist"), { recursive: true });

    await expect(
      execute(process.execPath, [viteBin, "preview"], {
        cwd: root,
        env: { ...environment(), PORTLESS_TAILSCALE_URL: "", PORTLESS_URL: "" },
      })
    ).rejects.toThrow("does not exist. Did you build your project?");
  });

  it("keeps build output free of Portless URLs", async () => {
    const result = await execute(process.execPath, [viteBin, "build"], {
      cwd: root,
      env: environment(),
    });

    expect(result.stdout).toContain("built in");
    expect(result.stdout).not.toContain("app.localhost");
    await expect(readFile(path.join(root, "dist", "index.html"), "utf-8")).resolves.toContain(
      "Source fixture"
    );
  });

  it.for(["development", "preview"])(
    "keeps native CLI output outside Portless: %s",
    async (mode) => {
      const args = [
        viteBin,
        ...(mode === "preview" ? ["preview"] : []),
        "--host",
        "127.0.0.1",
        "--port",
        String(await freePort()),
        "--strictPort",
      ];

      const running = launch(
        process.execPath,
        args,
        { ...environment(), PORTLESS_TAILSCALE_URL: "", PORTLESS_URL: "" },
        "Local:"
      );

      await running.ready;

      expect(running.output()).not.toContain("app.localhost");
      expect(running.output()).not.toContain("tailnet.ts.net");
      expect(running.output()).toContain("Local:");
    }
  );

  it.for(["development", "preview"])(
    "opens the sharing URL without blocking other shortcuts: %s",
    async (mode) => {
      const port = await freePort();
      const browserLog = path.join(root, "browser.log");
      const browserScript = path.join(root, "browser.js");
      const release = path.join(root, "release-browser");
      await writeFile(
        browserScript,
        'import { appendFileSync, existsSync } from "node:fs"; appendFileSync(process.env.TEST_BROWSER_LOG, process.argv.at(-1) + "\\n"); const timer = setInterval(() => { if (existsSync(process.env.TEST_BROWSER_RELEASE)) clearInterval(timer); }, 20);'
      );
      await writeFile(
        path.join(root, "interactive.mjs"),
        `
      import { createServer, preview } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(viteEntry), "dist", "node", "index.js")).href)};
      import { portless } from ${JSON.stringify(pluginUrl)};
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      const configuration = { configFile: false, plugins: [portless()], server: { host: "127.0.0.1", port: ${port} }, preview: { host: "127.0.0.1", port: ${port} } };
      const server = ${JSON.stringify(mode)} === "preview" ? await preview(configuration) : await createServer(configuration);
      if (${JSON.stringify(mode)} === "development") await server.listen();
      server.printUrls();
      server.bindCLIShortcuts({ print: false, customShortcuts: [{ key: "x", description: "control probe", action: () => console.log("CONTROL HANDLED") }] });
    `
      );

      const running = launch(process.execPath, [path.join(root, "interactive.mjs")], {
        ...environment(),
        BROWSER: browserScript,
        CI: "",
        TEST_BROWSER_LOG: browserLog,
        TEST_BROWSER_RELEASE: release,
      });

      try {
        await running.ready;
        running.child.stdin?.write("o\n");
        await vi.waitFor(async () => {
          await expect(readFile(browserLog, "utf-8")).resolves.toBe(
            "https://machine.tailnet.ts.net:8443/\n"
          );
        });
        running.child.stdin?.write("x\n");
        await vi.waitFor(() => {
          expect(running.output()).toContain("CONTROL HANDLED");
        });
      } finally {
        await writeFile(release, "release");
      }
    }
  );

  it.for(["omitted", "empty"])(
    "retains a custom preview o action after a rebind with %s shortcuts",
    async (shortcuts) => {
      const port = await freePort();
      await writeFile(
        path.join(root, "rebind.mjs"),
        `
      import { preview } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(viteEntry), "dist", "node", "index.js")).href)};
      import { portless } from ${JSON.stringify(pluginUrl)};
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      const server = await preview({ configFile: false, plugins: [portless()], preview: { host: "127.0.0.1", port: ${port} } });
      server.bindCLIShortcuts({ print: false, customShortcuts: [{ key: "o", description: "user browser", action: () => console.log("USER OPENER") }] });
      server.bindCLIShortcuts(${shortcuts === "empty" ? "{ print: false, customShortcuts: [] }" : "{ print: false }"});
      console.log("SHORTCUTS READY");
    `
      );

      const running = launch(
        process.execPath,
        [path.join(root, "rebind.mjs")],
        { ...environment(), CI: "" },
        "SHORTCUTS READY"
      );

      await running.ready;
      running.child.stdin?.write("o\n");
      await vi.waitFor(() => {
        expect(running.output()).toContain("USER OPENER");
      });
    }
  );
});
