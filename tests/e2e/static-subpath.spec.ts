import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { build } from "vite";

// GitHub Pages serves a project site under /<repo>/ and sends no COOP/COEP
// headers. The runtime must work from a subpath, isolating itself with its
// service worker after one reload.
const BASE = "/Neutron/";
const PORT = 4362;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".map": "application/json",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".svg": "image/svg+xml",
	".png": "image/png",
};
let out = "";
let server: Server;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	test.setTimeout(180_000);
	out = await mkdtemp(join(tmpdir(), "neutron-pages-"));
	const previous = process.env.VITE_NEUTRON_RELAY;
	// Stand in for the public relay with the local test relay.
	process.env.VITE_NEUTRON_RELAY = "ws://127.0.0.1:4174/wisp/";
	try {
		await build({
			base: BASE,
			logLevel: "warn",
			build: { outDir: out, emptyOutDir: true },
		});
	} finally {
		if (previous === undefined) delete process.env.VITE_NEUTRON_RELAY;
		else process.env.VITE_NEUTRON_RELAY = previous;
	}
	server = createServer(async (request, response) => {
		const pathname = decodeURIComponent((request.url || "/").split("?")[0] || "/");
		if (!pathname.startsWith(BASE)) {
			response.writeHead(404).end();
			return;
		}
		let file = resolve(out, `.${pathname.slice(BASE.length - 1)}`);
		if (file !== out && !file.startsWith(`${out}${sep}`)) {
			response.writeHead(403).end();
			return;
		}
		try {
			if ((await stat(file)).isDirectory()) file = join(file, "index.html");
			await stat(file);
		} catch {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": TYPES[extname(file)] || "application/octet-stream",
		});
		createReadStream(file).pipe(response);
	});
	await new Promise<void>((done) => server.listen(PORT, "127.0.0.1", done));
});
test.afterAll(async () => {
	await new Promise((done) => server?.close(done));
	if (out) await rm(out, { recursive: true, force: true });
});

test("a subpath deployment without isolation headers runs apps, isolated", async ({ page }) => {
	const outside: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			/^https?:$/.test(url.protocol) &&
			url.origin === ORIGIN &&
			!url.pathname.startsWith(BASE)
		)
			outside.push(url.pathname);
	});
	await page.goto(`${ORIGIN}${BASE}`);
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 60_000 });
	expect(
		await page.evaluate(() => ({
			isolated: crossOriginIsolated,
			worker: navigator.serviceWorker.controller?.scriptURL,
		})),
	).toEqual({ isolated: true, worker: `${ORIGIN}${BASE}sw.js` });

	const archive = createAsar({
		"package.json": '{"name":"pages-app","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain,net}=require('electron');const fs=require('fs');
ipcMain.on('sync',event=>event.returnValue=fs.readFileSync('/tmp/saved','utf8'));
app.whenReady().then(async()=>{fs.writeFileSync('/tmp/saved','persisted');const api=await (await net.fetch('http://127.0.0.1:4175/api')).json();
const w=new BrowserWindow({webPreferences:{nodeIntegration:true,contextIsolation:false}});await w.loadFile('index.html');
await w.webContents.executeJavaScript('document.body.dataset.network='+JSON.stringify(api.message));
const zlib=require('zlib');const brotli=zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from('brotli round trip'))).toString();
await w.webContents.executeJavaScript('document.body.dataset.brotli='+JSON.stringify(brotli));});`,
		"index.html": `<html><head><title>Pages app</title><link rel="stylesheet" href="style.css"></head><body><p id="sync"></p><script>document.querySelector('#sync').textContent=require('electron').ipcRenderer.sendSync('sync')</script></body></html>`,
		"style.css": "body{color:rgb(1, 2, 3)}",
	});
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const app = page.frameLocator("iframe[data-neutron-id='1']");
	await expect(app.locator("#sync")).toHaveText("persisted");
	await expect(app.locator("body")).toHaveAttribute("data-network", "through-wisp");
	// WASM codecs load from the runtime base, not the site root.
	await expect(app.locator("body")).toHaveAttribute("data-brotli", "brotli round trip");
	await expect(app.locator("body")).toHaveCSS("color", "rgb(1, 2, 3)");
	expect(await page.locator("iframe[data-neutron-id='1']").getAttribute("src")).toMatch(
		new RegExp(`^${BASE}__scramjet__/`),
	);
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.reload();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(app.locator("#sync")).toHaveText("persisted");
	expect(outside).toEqual([]);
});
