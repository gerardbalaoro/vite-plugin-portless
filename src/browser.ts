import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import open from "open";
import type { Logger } from "vite";

export const observeBrowserProcess = (
  child: ChildProcess,
  logger: Logger,
  description: string
): void => {
  let reported = false;

  const report = (message: string) => {
    if (!reported) {
      reported = true;
      logger.error(message);
    }
  };

  const reportExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal !== null) {
      report(`${description} exited with signal ${signal}.`);
    } else if (code !== null && code !== 0) {
      report(`${description} exited with code ${code}.`);
    }
  };

  // Some launchers, including Windows PowerShell through open, have already closed on return.
  if (child.exitCode !== null || child.signalCode !== null) {
    reportExit(child.exitCode, child.signalCode);

    return;
  }

  child.once("error", (error) => {
    report(error.message);
  });
  child.once("close", reportExit);
};

/** Start the preview browser and report process failures without waiting for browser scripts to exit. */
export const openPreviewBrowser = async (url: string, logger: Logger): Promise<void> => {
  const browser = process.env.BROWSER ?? "";

  if (browser.toLowerCase() === "none") {
    return;
  }

  try {
    if (browser.toLowerCase().endsWith(".js")) {
      const child = spawn(process.execPath, [browser, ...process.argv.slice(2), url], {
        stdio: "inherit",
      });

      observeBrowserProcess(
        child,
        logger,
        `The script specified as BROWSER environment variable failed.\n${browser}`
      );

      return;
    }

    const useDefaultBrowser = !browser || (process.platform === "darwin" && browser === "open");

    const options = useDefaultBrowser
      ? {}
      : { app: { arguments: process.env.BROWSER_ARGS?.split(" ") ?? [], name: browser } };

    const child = await open(url, options);

    observeBrowserProcess(child, logger, `Could not open browser ${browser}:`);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
  }
};
