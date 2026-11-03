import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ExecFileOptions, SpawnOptionsWithoutStdio } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

interface CommandOutput {
  stderr: string;
  stdout: string;
}

export const execute = async (
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<CommandOutput> => {
  const completed = Promise.withResolvers<CommandOutput>();

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Adapt Node's callback-only process API into a typed promise.
  execFile(command, args, { ...options, encoding: "utf-8" }, (error, stdout, stderr) => {
    if (error === null) {
      completed.resolve({ stderr, stdout });
    } else {
      completed.reject(
        new Error([error.message, stdout, stderr].filter(Boolean).join("\n"), { cause: error })
      );
    }
  });

  return await completed.promise;
};

const isTcpAddress = (address: AddressInfo | string | null): address is AddressInfo =>
  address !== null && typeof address !== "string";

export const freePort = async (): Promise<number> => {
  const server = createServer();
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  const closed = Promise.withResolvers<undefined>();

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node's close callback reports completion and errors.
  server.close((error) => {
    if (error === undefined) {
      closed.resolve(undefined);
    } else {
      closed.reject(error);
    }
  });

  await closed.promise;

  if (!isTcpAddress(address)) {
    throw new Error("The TCP fixture did not receive a port.");
  }

  return address.port;
};

export interface RunningCommand {
  child: ChildProcess;
  output: () => string;
  ready: Promise<void>;
}

export const startCommand = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  readyText: string
): RunningCommand => {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });

  const readiness = Promise.withResolvers<undefined>();
  let output = "";

  const append = (chunk: Buffer) => {
    output += stripVTControlCharacters(chunk.toString());

    if (output.includes(readyText)) {
      readiness.resolve(undefined);
    }
  };

  const timer = setTimeout(() => {
    readiness.reject(new Error(`Command did not become ready:\n${output}`));
  }, 15_000);

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", readiness.reject);
  child.once("exit", (code) => {
    readiness.reject(new Error(`Command exited (${String(code)}):\n${output}`));
  });

  return {
    child,
    output: () => output,
    ready: readiness.promise.finally(() => {
      clearTimeout(timer);
    }),
  };
};

export const stopCommand = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }

  const closed = once(child, "close");

  if (process.platform === "win32") {
    try {
      await execute("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } catch (error) {
      // taskkill can fail when a process exits after its tree was enumerated.
      // Its callback can also run before Node receives the root's exit event.
      await Promise.race([closed, delay(5000, undefined, { ref: false })]);

      if (child.exitCode === null && child.signalCode === null) {
        throw error;
      }
    }
  } else {
    process.kill(-child.pid, "SIGTERM");
  }

  await closed;
};
