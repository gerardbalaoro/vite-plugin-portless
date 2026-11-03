import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { createLogger, createServer, preview, version } from "vite";
import type {
  BindCLIShortcutsOptions,
  InlineConfig,
  Plugin,
  PreviewServer,
  ViteDevServer,
} from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { portless } from "../src/index.js";
import { freePort } from "./processes.js";

describe("real Vite servers", () => {
  let root = "";
  let lines: string[] = [];
  let servers: (ViteDevServer | PreviewServer)[] = [];
  let logger = createLogger();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vite-portless-"));
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(root, "index.html"), "<h1>Portless fixture</h1>");
    await writeFile(path.join(root, "dist", "index.html"), "<h1>Built fixture</h1>");
    await writeFile(
      path.join(root, "browser.js"),
      'import { appendFileSync } from "node:fs"; appendFileSync(process.env.TEST_BROWSER_LOG, process.argv.at(-1) + "\\n");'
    );
    lines = [];
    servers = [];
    logger = createLogger("info", { allowClearScreen: false });
    logger.info = (message) => {
      lines.push(stripVTControlCharacters(message));
    };

    vi.stubEnv("PORTLESS_URL", "https://app.localhost");
    vi.stubEnv("PORTLESS_TAILSCALE_URL", undefined);
    vi.stubEnv("PORTLESS_LAN", undefined);
    vi.stubEnv("BROWSER", path.join(root, "browser.js"));
    vi.stubEnv("TEST_BROWSER_LOG", path.join(root, "browser.log"));
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(async (server) => {
        await server.close();
      })
    );
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    vi.unstubAllEnvs();
  });

  const startDev = async (extra: InlineConfig = {}) => {
    const server = await createServer({
      ...extra,
      configFile: false,
      customLogger: extra.customLogger ?? logger,
      plugins: [...(extra.plugins ?? []), portless()],
      root,
      server: { host: "127.0.0.1", ...extra.server, port: await freePort() },
    });

    servers.push(server);
    await server.listen();

    return server;
  };

  const startPreview = async (extra: InlineConfig = {}) => {
    const server = await preview({
      ...extra,
      configFile: false,
      customLogger: extra.customLogger ?? logger,
      plugins: [...(extra.plugins ?? []), portless()],
      preview: { host: "127.0.0.1", ...extra.preview, port: await freePort() },
      root,
    });

    servers.push(server);

    return server;
  };

  const start = async (mode: string, extra: InlineConfig = {}) =>
    mode === "development" ? await startDev(extra) : await startPreview(extra);

  const decoratePrinter = (server: ViteDevServer | PreviewServer) => {
    const original = server.printUrls.bind(server);

    server.printUrls = () => {
      logger.info("Custom printer message");
      original();
    };
  };

  it("runs the requested Vite version", () => {
    const versions = new Map([
      ["vite", "7.3.1"],
      ["vite-6", "6.4.1"],
      ["vite-7-0", "7.3.0"],
    ]);

    expect(version).toBe(versions.get(process.env.VITE_TEST_PACKAGE ?? "vite"));
  });

  it.for(["development", "preview"])(
    "prints grouped URLs without changing native state: %s",
    async (mode) => {
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net:8443");
      const server = await start(mode);
      const native = server.resolvedUrls;
      const descriptor = Object.getOwnPropertyDescriptor(server, "resolvedUrls");
      const address = server.httpServer?.address();
      server.printUrls();

      expect(lines).toStrictEqual([
        `  ➜  Local:   ${native?.local[0]}`,
        "              https://app.localhost/",
        "  ➜  Network: https://machine.tailnet.ts.net:8443/",
      ]);
      expect(server.resolvedUrls).toBe(native);
      expect(Object.getOwnPropertyDescriptor(server, "resolvedUrls")).toStrictEqual(descriptor);
      expect(server.httpServer?.address()).toStrictEqual(address);
      expect(server.config.logger).toBe(logger);
    }
  );

  it.for(["development", "preview"])(
    "groups LAN and Tailscale sharing together: %s",
    async (mode) => {
      vi.stubEnv("PORTLESS_LAN", "1");
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net");
      const server = await start(mode);
      server.printUrls();

      expect(lines.slice(1)).toStrictEqual([
        "  ➜  Network: https://app.localhost/",
        "              https://machine.tailnet.ts.net/",
      ]);
    }
  );

  it.for(["", "./", "/app", "/app/", "/a%20b/", "https://cdn.example/app/"])(
    "preserves Vite's resolved base in both modes: %s",
    async (base) => {
      const development = await startDev({ base });
      development.printUrls();

      const developmentPath = new URL(development.resolvedUrls?.local[0] ?? "http://localhost")
        .pathname;

      const previewServer = await startPreview({ base });
      previewServer.printUrls();

      const previewPath = new URL(previewServer.resolvedUrls?.local[0] ?? "http://localhost")
        .pathname;

      expect(lines).toContain(`              https://app.localhost${developmentPath}`);
      expect(lines).toContain(`              https://app.localhost${previewPath}`);
    }
  );

  it("retains all actual interface URLs without synthesizing addresses", async () => {
    const server = await startDev({ server: { host: true, port: 0 } });
    const native = structuredClone(server.resolvedUrls);
    server.printUrls();
    const printed = lines.flatMap((line) => line.match(/https?:\/\/\S+/gu) ?? []);

    expect(printed).toStrictEqual([
      ...(native?.local ?? []),
      "https://app.localhost/",
      ...(native?.network ?? []),
    ]);
    expect(server.resolvedUrls).toStrictEqual(native);
  });

  it("preserves native errors before listening and after close", async () => {
    const server = await createServer({ configFile: false, plugins: [portless()], root });
    servers.push(server);

    expect(() => {
      server.printUrls();
    }).toThrow("before server.listen is called");
    await server.listen();
    await server.close();
    expect(server.resolvedUrls).toBeNull();
    expect(() => {
      server.printUrls();
    }).toThrow("before server.listen is called");
  });

  it("keeps a custom startup message and prevents nested adapters on duplicate registration", async () => {
    const observer: Plugin = {
      configureServer: () => {
        logger.info("Custom URL: http://literal.example:9999");
      },
      name: "custom-startup",
    };

    const server = await startDev({ plugins: [observer, portless()] });
    server.printUrls();

    expect(lines).toStrictEqual([
      "Custom URL: http://literal.example:9999",
      `  ➜  Local:   ${server.resolvedUrls?.local[0]}`,
      "              https://app.localhost/",
    ]);
  });

  it.for([
    { mode: "development", order: "before" },
    { mode: "development", order: "after" },
    { mode: "preview", order: "before" },
    { mode: "preview", order: "after" },
  ])(
    "preserves printer decorators registered $order Portless in $mode",
    async ({ mode, order }) => {
      const decorator: Plugin = {
        configurePreviewServer: decoratePrinter,
        configureServer: decoratePrinter,
        name: "printer-decoration",
      };

      const plugins = order === "before" ? [decorator, portless()] : [portless(), decorator];
      const server = await start(mode, { plugins });
      server.printUrls();

      expect(lines).toStrictEqual([
        "Custom printer message",
        `  ➜  Local:   ${server.resolvedUrls?.local[0]}`,
        "              https://app.localhost/",
      ]);
    }
  );

  it("keeps separate servers independent", async () => {
    const first = await startDev();
    vi.stubEnv("PORTLESS_URL", "https://second.localhost");
    const second = await startDev();
    lines = [];
    first.printUrls();
    second.printUrls();

    expect(lines).toStrictEqual([
      `  ➜  Local:   ${first.resolvedUrls?.local[0]}`,
      "              https://app.localhost/",
      `  ➜  Local:   ${second.resolvedUrls?.local[0]}`,
      "              https://second.localhost/",
    ]);
  });

  it("prints fresh URLs after a development restart", async () => {
    const server = await startDev();
    await server.restart();
    lines = [];
    server.printUrls();

    expect(lines).toStrictEqual([
      `  ➜  Local:   ${server.resolvedUrls?.local[0]}`,
      "              https://app.localhost/",
    ]);
  });

  it("leaves middleware mode and its native printer unchanged", async () => {
    let original: ViteDevServer["printUrls"] | undefined;

    const observer: Plugin = {
      configureServer: (server) => {
        // oxlint-disable-next-line typescript/unbound-method -- Compare identity without invoking the method.
        original = server.printUrls;
      },
      name: "capture-printer",
    };

    const server = await createServer({
      configFile: false,
      plugins: [observer, portless()],
      root,
      server: { middlewareMode: true },
    });

    servers.push(server);

    // oxlint-disable-next-line typescript/unbound-method -- Compare identity without invoking the method.
    expect(server.printUrls).toBe(original);
    expect(server.resolvedUrls).toBeNull();
  });

  it("honors a silent logger", async () => {
    const silent = createLogger("silent");
    // oxlint-disable-next-line typescript/unbound-method -- Compare identity without invoking the method.
    const { info } = silent;
    const output = vi.spyOn(console, "log");
    const server = await startDev({ customLogger: silent });
    server.printUrls();

    expect(output).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- Compare identity without invoking the method.
    expect(silent.info).toBe(info);
  });

  it("preserves explicit networking and asset configuration", async () => {
    const networking = {
      allowedHosts: ["custom.example"],
      hmr: false,
      host: "127.0.0.1",
      origin: "https://assets.example",
      port: 0,
      strictPort: true,
    };

    vi.stubEnv("PORTLESS_URL", undefined);
    const baseline = await startDev({ server: structuredClone(networking) });
    vi.stubEnv("PORTLESS_URL", "https://app.localhost");
    const server = await startDev({ server: structuredClone(networking) });

    expect(server.config.server).toMatchObject({
      allowedHosts: baseline.config.server.allowedHosts,
      hmr: baseline.config.server.hmr,
      host: baseline.config.server.host,
      origin: baseline.config.server.origin,
      strictPort: baseline.config.server.strictPort,
    });
    expect(server.httpServer?.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it.for([
    { expected: "/app/", open: true },
    { expected: "/dashboard", open: "/dashboard" },
    { expected: "/app/dashboard", open: "dashboard" },
    { expected: "https://external.example/path", open: "https://external.example/path" },
    { expected: "https://external.example/path", open: "//external.example/path" },
  ])("opens the preferred URL once in both modes: $open", async ({ expected, open: setting }) => {
    vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net:8443");

    const expectedUrl = expected.startsWith("https:")
      ? expected
      : `https://machine.tailnet.ts.net:8443${expected}`;

    const dev = await startDev({ base: "/app/", server: { open: setting } });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, "browser.log"), "utf-8")).resolves.toBe(
        `${expectedUrl}\n`
      );
    });
    await startPreview({ base: "/app/", preview: { open: setting } });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, "browser.log"), "utf-8")).resolves.toBe(
        `${expectedUrl}\n${expectedUrl}\n`
      );
    });
    expect(dev.config.server.open).toBe(setting);
  });

  it("does not auto-open a browser but opens the Portless URL on a manual development action", async () => {
    const server = await startDev({ server: { open: false } });
    await startPreview({ preview: { open: false } });

    await expect(readFile(path.join(root, "browser.log"), "utf-8")).rejects.toThrow("ENOENT");
    server.openBrowser();
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, "browser.log"), "utf-8")).resolves.toBe(
        "https://app.localhost/\n"
      );
    });
    expect(server.config.server.open).toBeFalsy();
  });

  it("opens the preferred URL from the preview shortcut and preserves other shortcuts", async () => {
    let bound: BindCLIShortcutsOptions<PreviewServer> | undefined;

    const observer: Plugin = {
      configurePreviewServer: {
        handler: (server) => {
          const original = server.bindCLIShortcuts.bind(server);
          server.bindCLIShortcuts = (settings) => {
            bound = settings;
            original(settings);
          };
        },
        order: "pre",
      },
      name: "observe-shortcuts",
    };

    const server = await startPreview({ plugins: [observer] });

    const custom = {
      action: () => {
        lines.push("custom");
      },
      description: "custom",
      key: "x",
    };

    server.bindCLIShortcuts({ customShortcuts: [custom], print: false });
    const shortcut = bound?.customShortcuts?.find((entry) => entry.key === "o");
    await shortcut?.action?.(server);

    expect(bound?.customShortcuts?.[0]).toBe(custom);
    expect(shortcut?.description).toBe("open in browser");
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, "browser.log"), "utf-8")).resolves.toBe(
        "https://app.localhost/\n"
      );
    });
  });

  it("keeps a user's custom preview o action authoritative", async () => {
    let bound: BindCLIShortcutsOptions<PreviewServer> | undefined;

    const observer: Plugin = {
      configurePreviewServer: {
        handler: (server) => {
          const original = server.bindCLIShortcuts.bind(server);
          server.bindCLIShortcuts = (settings) => {
            bound = settings;
            original(settings);
          };
        },
        order: "pre",
      },
      name: "observe-shortcuts",
    };

    const server = await startPreview({ plugins: [observer] });

    const custom = {
      action: () => {
        lines.push("custom browser action");
      },
      description: "user browser",
      key: "o",
    };

    const settings = { customShortcuts: [custom] };
    server.bindCLIShortcuts(settings);
    await bound?.customShortcuts?.[0]?.action?.(server);

    expect(bound).toBe(settings);
    expect(lines).toContain("custom browser action");
    await expect(readFile(path.join(root, "browser.log"), "utf-8")).rejects.toThrow("ENOENT");
  });
});
