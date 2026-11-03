import colors from "picocolors";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

import { openPreviewBrowser } from "./browser.js";
import type { PortlessEnvironment } from "./urls.js";
import { browserDestination, createUrlPlan, readEnvironment } from "./urls.js";

const installed = new WeakSet<ViteDevServer | PreviewServer>();

const groupLines = (label: string, urls: string[]): string[] =>
  urls.map((url, index) => {
    const prefix =
      index === 0
        ? `  ${colors.green("➜")}  ${colors.bold(`${label}:`)}${" ".repeat(9 - label.length - 1)}`
        : " ".repeat(14);

    return `${prefix}${colors.cyan(url)}`;
  });

const installPrinter = (
  server: ViteDevServer | PreviewServer,
  environment: PortlessEnvironment,
  host: () => string | boolean | undefined
) => {
  const original = server.printUrls.bind(server);

  server.printUrls = () => {
    const plan = createUrlPlan(server.resolvedUrls, environment);

    if (!plan) {
      original();

      return;
    }

    const { logger } = server.config;

    for (const line of [
      ...groupLines("Local", plan.urls.local),
      ...groupLines("Network", plan.urls.network),
    ]) {
      logger.info(line);
    }

    if (
      plan.urls.network.length === 0 &&
      host() === undefined &&
      environment.tailscaleOrigin === undefined &&
      !(environment.lan && environment.appOrigin !== undefined)
    ) {
      logger.info(
        colors.dim(`  ${colors.green("➜")}  ${colors.bold("Network")}: use `) +
          colors.bold("--host") +
          colors.dim(" to expose")
      );
    }
  };
};

const installDevBrowser = (server: ViteDevServer, environment: PortlessEnvironment) => {
  const original = server.openBrowser.bind(server);

  server.openBrowser = () => {
    const plan = createUrlPlan(server.resolvedUrls, environment);

    if (!plan) {
      original();

      return;
    }

    const { server: options } = server.config;
    const previous = options.open;

    options.open = browserDestination(previous, plan.preferred);

    try {
      original();
    } finally {
      options.open = previous;
    }
  };
};

const installPreviewBrowser = (server: PreviewServer, environment: PortlessEnvironment) => {
  const options = server.config.preview;
  let configuredOpen = options.open;

  // Vite reads this public configuration after assigning resolvedUrls and before opening the browser.
  Object.defineProperty(options, "open", {
    configurable: true,
    enumerable: true,
    get: () => {
      const plan = createUrlPlan(server.resolvedUrls, environment);

      return configuredOpen !== false && configuredOpen !== "" && plan !== undefined
        ? browserDestination(configuredOpen, plan.preferred)
        : configuredOpen;
    },
    set: (value: boolean | string) => {
      configuredOpen = value;
    },
  });

  const original = server.bindCLIShortcuts.bind(server);
  // Later bindings can omit existing shortcuts, so caller ownership must outlive each call.
  let userOwnsOpen = false;

  server.bindCLIShortcuts = (settings) => {
    const customShortcuts = settings?.customShortcuts ?? [];
    userOwnsOpen ||= customShortcuts.some((shortcut) => shortcut.key === "o");

    if (userOwnsOpen) {
      original(settings);

      return;
    }

    original({
      ...settings,
      customShortcuts: [
        ...customShortcuts,
        {
          action: async () => {
            const url =
              createUrlPlan(server.resolvedUrls, environment)?.preferred ??
              server.resolvedUrls?.local[0] ??
              server.resolvedUrls?.network[0];

            if (url === undefined) {
              server.config.logger.warn("No URL available to open in browser");
            } else {
              await openPreviewBrowser(url, server.config.logger);
            }
          },
          description: "open in browser",
          key: "o",
        },
      ],
    });
  };
};

/** Add Portless URLs to Vite's startup output without changing its listener. */
export const portless = (): Plugin => {
  const environment = readEnvironment();

  if (environment.appOrigin === undefined && environment.tailscaleOrigin === undefined) {
    return { name: "vite-plugin-portless" };
  }

  return {
    configurePreviewServer: {
      handler: (server) => {
        if (installed.has(server)) {
          return;
        }

        installed.add(server);
        installPrinter(server, environment, () => server.config.preview.host);
        installPreviewBrowser(server, environment);
      },
      order: "pre",
    },
    configureServer: {
      handler: (server) => {
        if (server.config.server.middlewareMode !== false || installed.has(server)) {
          return;
        }

        installed.add(server);
        installPrinter(server, environment, () => server.config.server.host);
        installDevBrowser(server, environment);
      },
      order: "pre",
    },
    name: "vite-plugin-portless",
  };
};
