# Neutron

[![CI](https://github.com/hazelcaffe/Neutron/actions/workflows/ci.yml/badge.svg)](https://github.com/hazelcaffe/Neutron/actions/workflows/ci.yml)

Run unmodified Electron apps in the browser.

Try it at https://hazelcaffe.github.io/Neutron/ (Chrome, Edge or another Chromium-based browser).

Neutron reimplements Electron's and Node's APIs in JavaScript and WebAssembly. The app's main process runs in a Web Worker and its windows run in the page. Your files stay in the browser's storage (OPFS) and aren't uploaded anywhere.

Experimental. Not affiliated with Electron or with any app mentioned here.

## Usage

Import an installed app's `resources` folder, or a ZIP of it, and press **Run**. Include everything in that folder, especially `app.asar.unpacked`.

Set **Settings → Platform** to the platform the app was built for.

## What works

Apps tested with their official packages: Obsidian, VS Code, Joplin, draw.io, Vesktop, GitHub Desktop, Postman, Insomnia, Figma, Signal and others. See [docs/compatibility-results.md](docs/compatibility-results.md) for what was tested in each.

Native addons (`.node` files) don't run. Neutron has browser versions of a few: SQLite, SQLCipher, libsignal (built for WebAssembly, see [packages/libsignal-wasm](packages/libsignal-wasm)), node-usb (over WebUSB) and keytar. Others are stubbed, and apps that need them for core features won't fully work. Some known gaps:

- Signal: linking a phone isn't confirmed to work yet, and calls don't work.
- 1Password: the app's native core doesn't run.
- TIDAL: playback needs native DRM, which isn't available.
- Passkeys for other sites don't work, because the browser ties them to Neutron's own address.

By default, an unsupported API logs a `[compat]` warning and does nothing. Turn on **Settings → Throw on unsupported APIs** to get errors instead.

## Networking

Apps reach the network through a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) relay. `pnpm dev` and `pnpm preview` run one locally. Otherwise Neutron uses `wss://anura.pro/`. Change it in **Settings → Wisp relay URL**.

TLS runs in the browser, so the relay can't read HTTPS traffic. It can see which hosts apps connect to.

## Security

Imported apps are trusted code. They share an origin with Neutron and with each other, so only import apps you trust. Don't expose the dev server on a network you don't trust, because its relay can reach your local network.

## Development

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # lint + typecheck
pnpm test         # unit tests
pnpm build        # static site in dist/
pnpm test:e2e     # browser tests (run `pnpm exec playwright install chromium` first)
```

To deploy under a subpath, build with `NEUTRON_BASE=/path/ pnpm build`. The site needs these headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

On hosts that can't set headers, like GitHub Pages, the service worker adds them after one reload.

Some browser tests run against official app packages. They're skipped unless you set variables like `NEUTRON_OBSIDIAN_RESOURCES=/path/to/resources`. `pnpm compat:fetch` downloads the packages and `pnpm compat:sweep` runs them all.

## Layout

- `packages/runtime`: the runtime, as a library ([API](packages/runtime/README.md))
- `packages/libsignal-wasm`: build recipe for libsignal as WebAssembly
- `packages/libcurl.js`: libcurl.js rebuilt with per-request CA support
- `src/`: the web app (React + Mantine)
- `tests/`: browser tests

## License

[AGPL-3.0-only](LICENSE). Bundled dependencies keep their own licenses.
