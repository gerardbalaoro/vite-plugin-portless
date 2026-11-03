import type { ResolvedServerUrls } from "vite";

export interface PortlessEnvironment {
  appOrigin: string | undefined;
  lan: boolean;
  tailscaleOrigin: string | undefined;
}

const parseOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "" || /[\s\p{Cc}]/u.test(value)) {
    return undefined;
  }

  if (!/^https?:\/\//iu.test(value) || !URL.canParse(value)) {
    return undefined;
  }

  const url = new URL(value);

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }

  return url.origin;
};

export const readEnvironment = (): PortlessEnvironment => ({
  appOrigin: parseOrigin(process.env.PORTLESS_URL),
  lan: process.env.PORTLESS_LAN === "1",
  tailscaleOrigin: parseOrigin(process.env.PORTLESS_TAILSCALE_URL),
});

export interface UrlPlan {
  preferred: string;
  urls: ResolvedServerUrls;
}

const uniqueUrls = (urls: string[], seen: Set<string>): string[] => {
  const result: string[] = [];

  for (const url of urls) {
    const key = URL.canParse(url) ? new URL(url).href : url;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(url);
    }
  }

  return result;
};

export const createUrlPlan = (
  native: ResolvedServerUrls | null,
  environment: PortlessEnvironment
): UrlPlan | undefined => {
  const template = native?.local[0] ?? native?.network[0];

  if (!native || template === undefined || template === "" || !URL.canParse(template)) {
    return undefined;
  }

  const parsed = new URL(template);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const app = environment.appOrigin === undefined ? undefined : `${environment.appOrigin}${suffix}`;

  const tailscale =
    environment.tailscaleOrigin === undefined
      ? undefined
      : `${environment.tailscaleOrigin}${suffix}`;

  const local = [...native.local];
  const network = [...native.network];

  if (app !== undefined) {
    (environment.lan ? network : local).push(app);
  }

  if (tailscale !== undefined) {
    network.push(tailscale);
  }

  const seen = new Set<string>();

  return {
    preferred: tailscale ?? app ?? template,
    urls: { local: uniqueUrls(local, seen), network: uniqueUrls(network, seen) },
  };
};

export const browserDestination = (
  setting: boolean | string | undefined,
  preferred: string
): string => {
  if (setting === true || setting === false || setting === undefined) {
    return preferred;
  }

  return new URL(setting, preferred).href;
};
