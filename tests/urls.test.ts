import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { portless } from "../src/index.js";
import { browserDestination, createUrlPlan, readEnvironment } from "../src/urls.js";

describe("Portless URLs", () => {
  beforeEach(() => {
    vi.stubEnv("PORTLESS_URL", undefined);
    vi.stubEnv("PORTLESS_TAILSCALE_URL", undefined);
    vi.stubEnv("PORTLESS_LAN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe(readEnvironment, () => {
    it.for([
      undefined,
      "",
      "https:app.localhost",
      "ftp://app.localhost",
      "https://user:password@app.localhost",
      "https://app.localhost/path",
      "https://app.localhost/?",
      "https://app.localhost/#",
      "https://app.localhost/?key=value",
      "https://app.localhost/#fragment",
      " https://app.localhost",
      "https://app.localhost\n",
      "https://app.localhost/\u0001",
      "not a URL",
    ])("omits invalid origins: %s", (value) => {
      vi.stubEnv("PORTLESS_URL", value);
      vi.stubEnv("PORTLESS_TAILSCALE_URL", value);

      expect(portless()).toStrictEqual({ name: "vite-plugin-portless" });
    });

    it("normalizes origins and reads independent sharing variables", () => {
      vi.stubEnv("PORTLESS_URL", "HTTPS://APP.LOCALHOST:443/");
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net:8443");
      vi.stubEnv("PORTLESS_LAN", "1");

      expect(readEnvironment()).toStrictEqual({
        appOrigin: "https://app.localhost",
        lan: true,
        tailscaleOrigin: "https://machine.tailnet.ts.net:8443",
      });
    });

    it.for([
      ["invalid", "https://machine.tailnet.ts.net", undefined, "https://machine.tailnet.ts.net"],
      ["https://app.localhost", "invalid", "https://app.localhost", undefined],
    ])(
      "omits each invalid origin independently: %s",
      ([app, tailscale, expectedApp, expectedTailscale]) => {
        vi.stubEnv("PORTLESS_URL", app);
        vi.stubEnv("PORTLESS_TAILSCALE_URL", tailscale);

        expect(readEnvironment()).toStrictEqual({
          appOrigin: expectedApp,
          lan: false,
          tailscaleOrigin: expectedTailscale,
        });
      }
    );

    it("keeps the environment snapshot independent of later changes", () => {
      vi.stubEnv("PORTLESS_URL", "https://first.localhost");
      const snapshot = readEnvironment();
      vi.stubEnv("PORTLESS_URL", "https://second.localhost");

      expect(snapshot.appOrigin).toBe("https://first.localhost");
      expect(readEnvironment().appOrigin).toBe("https://second.localhost");
    });
  });

  describe(createUrlPlan, () => {
    it("retains native interface URLs, groups supplied URLs, and prefers Tailscale for the browser", () => {
      vi.stubEnv("PORTLESS_URL", "https://app.localhost");
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net:8443");

      const native = {
        local: ["http://127.0.0.1:5173/"],
        network: ["http://192.168.1.42:5173/", "http://100.64.0.1:5173/"],
      };

      const before = structuredClone(native);

      expect(createUrlPlan(native, readEnvironment())).toStrictEqual({
        preferred: "https://machine.tailnet.ts.net:8443/",
        urls: {
          local: ["http://127.0.0.1:5173/", "https://app.localhost/"],
          network: [
            "http://192.168.1.42:5173/",
            "http://100.64.0.1:5173/",
            "https://machine.tailnet.ts.net:8443/",
          ],
        },
      });
      expect(native).toStrictEqual(before);
    });

    it("groups both LAN and Tailscale sharing URLs under Network", () => {
      vi.stubEnv("PORTLESS_URL", "https://app.localhost");
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://machine.tailnet.ts.net");
      vi.stubEnv("PORTLESS_LAN", "1");

      expect(
        createUrlPlan({ local: ["http://127.0.0.1:5173/"], network: [] }, readEnvironment())?.urls
      ).toStrictEqual({
        local: ["http://127.0.0.1:5173/"],
        network: ["https://app.localhost/", "https://machine.tailnet.ts.net/"],
      });
    });

    it.for(["/", "/app", "/app/", "/a%20b/", "/app/?q=%2F#section"])(
      "preserves the template suffix: %s",
      (suffix) => {
        vi.stubEnv("PORTLESS_URL", "http://app.localhost:1355");
        const expected = `http://app.localhost:1355${suffix}`;

        expect(
          createUrlPlan({ local: [], network: [`http://[::1]:5173${suffix}`] }, readEnvironment())
        ).toStrictEqual({
          preferred: expected,
          urls: { local: [expected], network: [`http://[::1]:5173${suffix}`] },
        });
      }
    );

    it("deduplicates normalized URLs across groups in display order", () => {
      vi.stubEnv("PORTLESS_URL", "https://app.localhost:443");
      vi.stubEnv("PORTLESS_TAILSCALE_URL", "https://app.localhost");

      expect(
        createUrlPlan(
          {
            local: ["https://APP.LOCALHOST:443/", "https://app.localhost/"],
            network: ["https://app.localhost/"],
          },
          readEnvironment()
        )?.urls
      ).toStrictEqual({
        local: ["https://APP.LOCALHOST:443/"],
        network: [],
      });
    });

    it.for([
      null,
      { local: [], network: [] },
      { local: ["broken"], network: [] },
      { local: ["ftp://localhost/"], network: [] },
    ])("does not fabricate URLs before readiness: %j", (native) => {
      vi.stubEnv("PORTLESS_URL", "https://app.localhost");

      expect(createUrlPlan(native, readEnvironment())).toBeUndefined();
    });
  });

  describe(browserDestination, () => {
    it.for([
      { expected: "https://app.localhost/app/", setting: true },
      { expected: "https://app.localhost/app/", setting: false },
      { expected: "https://app.localhost/app/", setting: undefined },
      { expected: "https://app.localhost/app/dashboard", setting: "dashboard" },
      { expected: "https://app.localhost/dashboard", setting: "/dashboard" },
      { expected: "https://external.example/landing", setting: "https://external.example/landing" },
      { expected: "https://external.example/landing", setting: "//external.example/landing" },
    ])("resolves browser configuration: $setting", ({ expected, setting }) => {
      expect(browserDestination(setting, "https://app.localhost/app/")).toBe(expected);
    });
  });
});
