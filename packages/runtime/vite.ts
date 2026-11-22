import { cp, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import type { Plugin, PreviewServer, ResolvedConfig, ViteDevServer } from "vite";
import { buildAssets, defaultAssetsDir } from "./scripts/assets.mjs";

export interface NeutronPluginOptions {
	/**
	 * Serve a same-origin Wisp relay at /wisp/ in `vite dev` and `vite preview`,
	 * and advertise it at /__neutron_dev__. Deployed sites need their own relay.
	 * @default true
	 */
	relay?: boolean;
	/**
	 * Fully reload the page after a runtime rebuild in `vite dev`. Off by default:
	 * a reload terminates the guest app, its unsaved work and sign-in flows.
	 * @default false
	 */
	reloadOnChange?: boolean;
}

/** Cross-origin isolation gives the runtime SharedArrayBuffer and synchronous IPC. */
export const isolationHeaders = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "credentialless",
} as const;

const MIME: Record<string, string> = {
	".wasm": "application/wasm",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".map": "application/json",
};
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = [
	"src/runtime/",
	"src/shared/",
	"src/service-worker.ts",
	"src/core/proxy-worker.ts",
].map((part) => resolve(ROOT, part));
const isAsset = (pathname: string) =>
	pathname === "/sw.js" || pathname.startsWith("/vendor/") || pathname.startsWith("/runtime/");

/**
 * Hosts the Neutron runtime in a Vite app. The runtime's service worker, guest
 * bundles and WASM modules must be served from the site root (`/sw.js`,
 * `/runtime/`, `/vendor/`); this plugin builds them, serves them in dev and
 * preview, and copies them into the production build. It also sets the
 * cross-origin isolation headers the runtime needs.
 */
export function neutron(options: NeutronPluginOptions = {}): Plugin {
	const relay = options.relay ?? true;
	let config: ResolvedConfig;
	let building: Promise<unknown> = Promise.resolve();
	const rebuild = () => {
		building = building.catch(() => {}).then(() => buildAssets(defaultAssetsDir));
		return building;
	};
	logging.set_level(logging.ERROR);
	const connections = new Set<Duplex>();
	const attach = (server: ViteDevServer | PreviewServer, assets: string) => {
		if (relay) {
			wisp.options.allow_private_ips = true;
			wisp.options.allow_loopback_ips = true;
			const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
				if (request.url?.split("?")[0] !== "/wisp/") return;
				// Don't let unrelated websites use this development relay.
				if (request.headers.origin) {
					let matches = false;
					try {
						matches = new URL(request.headers.origin).host === request.headers.host;
					} catch {
						/* Invalid Origin. */
					}
					if (!matches) {
						socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
						return;
					}
				}
				connections.add(socket);
				socket.once("close", () => connections.delete(socket));
				wisp.routeRequest(request, socket, head);
			};
			server.httpServer?.on("upgrade", upgrade);
			server.httpServer?.once("close", () => {
				for (const socket of connections) socket.destroy();
				connections.clear();
			});
		}
		server.middlewares.use((request, response, next) => {
			const pathname = (request.url || "").split("?")[0] || "/";
			if (relay && pathname === "/__neutron_dev__") {
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				});
				response.end(JSON.stringify({ wisp: "/wisp/" }));
				return;
			}
			if (relay && pathname === "/wisp/") {
				response.writeHead(426, { "Content-Type": "text/plain" });
				response.end("This endpoint uses WebSocket (Wisp).");
				return;
			}
			if (!isAsset(pathname)) {
				next();
				return;
			}
			// Serve generated assets explicitly: the WASM loader must never receive
			// the app's index.html, even while assets are rebuilding.
			void building
				.catch(() => {})
				.then(() => serveAsset(assets, pathname, request, response));
		});
	};
	return {
		name: "neutron-runtime",
		config: () => ({
			server: { headers: isolationHeaders },
			preview: { headers: isolationHeaders },
			worker: { format: "es" },
			optimizeDeps: { exclude: ["libcurl.js", "@mercuryworkshop/wisp-js/client"] },
		}),
		configResolved(resolved) {
			config = resolved;
		},
		async configureServer(server) {
			await rebuild();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const changed = (file: string) => {
				if (!SOURCES.some((source) => file.startsWith(source))) return;
				clearTimeout(timer);
				timer = setTimeout(() => {
					void rebuild().then(
						() => {
							if (options.reloadOnChange) server.ws.send({ type: "full-reload" });
						},
						(error: unknown) => server.config.logger.error(String(error)),
					);
				}, 100);
			};
			server.watcher.add(SOURCES);
			server.watcher.on("change", changed);
			server.httpServer?.once("close", () => {
				clearTimeout(timer);
				server.watcher.off("change", changed);
			});
			attach(server, defaultAssetsDir);
		},
		configurePreviewServer: (server) =>
			attach(server, resolve(server.config.root, server.config.build.outDir)),
		async buildStart() {
			if (config.command === "build") await rebuild();
		},
		async writeBundle() {
			await building;
			await cp(defaultAssetsDir, resolve(config.root, config.build.outDir), {
				recursive: true,
				filter: (source) => !source.endsWith(".tmp"),
			});
		},
		closeBundle: () => {
			for (const socket of connections) socket.destroy();
			connections.clear();
		},
	};
}

async function serveAsset(
	root: string,
	pathname: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const filename = resolve(root, `.${decodeURIComponent(pathname)}`);
		if (!filename.startsWith(`${root}${sep}`)) {
			response.writeHead(403);
			response.end();
			return;
		}
		const data = await readFile(filename);
		response.writeHead(200, {
			"Content-Type": MIME[extname(filename)] || "text/plain",
			"Content-Length": data.length,
			"Cache-Control": "no-store",
			...isolationHeaders,
		});
		response.end(request.method === "HEAD" ? undefined : data);
	} catch {
		response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
		response.end(`Runtime asset not found: ${pathname}`);
	}
}
