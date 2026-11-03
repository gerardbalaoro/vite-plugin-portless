# vite-plugin-portless

Show Vite's listener URLs alongside Portless local and sharing URLs in development and preview.

```text
  ➜  Local:   http://127.0.0.1:5173/
              https://app.localhost/
  ➜  Network: https://machine.mytailnet.ts.net:8443/
```

Requires Node.js 24 or later. Tested with Vite 6.4.1, 7.3.0, and 7.3.1.

## Installation

```sh
npm install --save-dev vite-plugin-portless

# or with pnpm
pnpm add -D vite-plugin-portless
```

## Usage

Add the plugin to your Vite configuration:

```ts
import { defineConfig } from "vite";
import { portless } from "vite-plugin-portless";

export default defineConfig({
  plugins: [portless()],
});
```

Run Vite through your existing Portless installation:

```sh
portless run --name app vite
portless run --name app vite preview
```

Build the application before preview. Package scripts work if they load this Vite configuration.

## Behavior

- Retains Vite's URLs and adds `PORTLESS_URL` and `PORTLESS_TAILSCALE_URL`.
- Groups LAN sharing under `Network` when `PORTLESS_LAN=1`.
- Preserves base paths, trailing slashes, and ports, and removes duplicate URLs.
- Browser actions prefer Tailscale, then the app proxy. Explicit `open` URLs take precedence.

Without valid Portless URL variables, Vite retains its native behavior. The plugin does not change
listeners, host validation, HTTPS, HMR, or routing.

## Development

Contributors need PNPM 12.15.0 and Bun 1.4.4 for the package-runner fixtures.

```sh
pnpm install
pnpm test
```
