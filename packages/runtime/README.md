# @neutron/runtime

The Neutron compatibility layer as a library: it imports an installed Electron app's `resources` folder (or a ZIP of it) into browser storage and runs it, unmodified, inside an element on your page. It doesn't include any UI. The Neutron app in the repository root is one UI built on this package.

## Setup

The runtime needs two things from the site that hosts it:

- Its assets under one **base path** (`/` by default): `<base>sw.js` (service worker, scope `<base>`), `<base>runtime/*` (guest bundles) and `<base>vendor/*` (Scramjet, libcurl, Wisp, SQLite and Brotli WASM). Virtual routes such as `<base>__scramjet__/` live under the same base.
- **Cross-origin isolation** headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. If the host can't send them (GitHub Pages, for example), the service worker adds them to the site's documents and worker scripts after one automatic reload.

With Vite, the plugin handles both:

```ts
// vite.config.ts
import { neutron } from "@neutron/runtime/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [neutron()] });
```

The plugin follows Vite's `base`, so `vite build --base /Neutron/` produces a build for a subpath. It builds the assets when the dev server starts and rebuilds them when runtime sources change. `vite build` copies them into the output directory. In `vite dev` and `vite preview`, it also serves a same-origin Wisp relay at `/wisp/` and advertises it at `/__neutron_dev__`. A static deployment needs its own relay for external networking. Options: `relay: false` turns off the development relay; `reloadOnChange: true` reloads the page after a runtime rebuild.

Without Vite, run `node packages/runtime/scripts/assets.mjs [out-dir]`, serve that directory at your base path, and pass `base` to `Neutron.create`.

## Use

```ts
import { Neutron } from "@neutron/runtime";

const neutron = await Neutron.create({ viewport: document.querySelector("#viewport")! });

neutron.on("state", (state) => console.log(state)); // stopped | starting | running | failed
neutron.on("log", (entry) => console.log(entry.source, entry.message));
neutron.on("windows", (windows) => renderTabs(windows));

const app = await neutron.importApp(
	{ files: folderInput.files! }, // or { zip: file }
	{ onProgress: (message) => console.log(message) },
);
await neutron.start(app, { relay: await Neutron.localRelay(), platform: "win32" });
```

App windows fill the viewport element; give it a size. Only one `Neutron` instance can exist per page.

### API

| Member                                                     | Description                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Neutron.create({ viewport, base?, reloadForIsolation? })` | Mounts the runtime: opens OPFS storage and verifies the service worker. `base` defaults to Vite's `BASE_URL`, otherwise `/`. Unless `reloadForIsolation` is false, it reloads the page once when the service worker must supply isolation headers.                                            |
| `Neutron.localRelay()`                                     | The development relay URL, or `""` when the host has none.                                                                                                                                                                                                                                    |
| `importApp(source, options?)`                              | Imports a folder (`{ files }`, e.g. an `<input webkitdirectory>` FileList) or `{ zip }`, including `app.asar.unpacked` and companion files. `options.chooseEntry(review)` decides ambiguous packages or entry points; `onProgress` and `signal` are optional. Resolves to the `InstalledApp`. |
| `listApps()`, `removeApp(id)`                              | Imported apps in browser storage. Removing a running app stops it first.                                                                                                                                                                                                                      |
| `start(app \| id, { relay, strict, platform })`            | Starts an app and stops any other. Without `relay`, the app runs offline. `strict` throws on unsupported APIs instead of using fallbacks.                                                                                                                                                     |
| `stop()`                                                   | Asks the app to quit, so it can save state, then stops it.                                                                                                                                                                                                                                    |
| `state`, `app`, `windows`, `menu`, `logs`                  | Current values; the matching events report changes. `logs` holds the most recent 2,000 entries.                                                                                                                                                                                               |
| `showWindow`, `hideWindow`, `reloadWindow`, `closeWindow`  | Window management by window ID. Closing goes through the app's `close` handler, so the app can cancel it.                                                                                                                                                                                     |
| `clickMenu(id)`                                            | Activates an application-menu item for the active window.                                                                                                                                                                                                                                     |
| `files(id)`                                                | The app's virtual filesystem: live while it runs, otherwise as last saved.                                                                                                                                                                                                                    |
| `loadSettings()`, `saveSettings(settings)`                 | A small settings record in browser storage, for embedders that want one.                                                                                                                                                                                                                      |
| `on(event, listener)`                                      | `state`, `log`, `windows`, `menu`, `notification`, `devtools` and `reveal` (`shell.showItemInFolder`). Returns an unsubscribe function.                                                                                                                                                       |
| `importSourceFromDrop(dataTransfer)`                       | Converts a dropped folder or ZIP into an import source. Call it synchronously in the `drop` handler.                                                                                                                                                                                          |
| `createAsar(files)`, `capabilities`, `capability(api)`     | Utilities: build an ASAR, and look up API support.                                                                                                                                                                                                                                            |

Window elements use the classes `runtime-window` and `runtime-view`. Message boxes and folder pickers that the app opens are native `<dialog class="neutron-dialog">` elements. The runtime's own styles have zero specificity, so a UI can restyle all of these.

## Tests

`packages/runtime/tests` holds the unit tests. From the repository root, run `pnpm test`. The end-to-end tests in the root `tests/e2e` drive the runtime through the Neutron app.
