import { describe, expect, it } from "vitest";

import { startCommand, stopCommand } from "./processes.js";

describe("command cleanup", () => {
  it("accepts a command exiting while termination starts", async () => {
    const running = startCommand(
      process.execPath,
      ["-e", 'console.log("READY"); process.stdin.once("data", () => process.exit(0));'],
      {},
      "READY"
    );

    try {
      await running.ready;
      running.child.stdin?.write("exit\n");

      await expect(stopCommand(running.child)).resolves.toBeUndefined();
      expect(running.child.exitCode !== null || running.child.signalCode !== null).toBeTruthy();
    } finally {
      await stopCommand(running.child);
    }
  });
});
