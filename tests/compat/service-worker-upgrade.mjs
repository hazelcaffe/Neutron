// node tests/compat/service-worker-upgrade.mjs <pre-persist-files build> <build under test>
// Both are read-only. Reopen the same private Chromium profile on the same origin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { preview } from "vite";

const [, , oldBuild, nextBuild] = process.argv;
assert(oldBuild && nextBuild, "Pass the legacy and candidate Neutron build directories");
const port = Number(process.env.NEUTRON_UPGRADE_PORT || 4236);
const origin = `http://127.0.0.1:${port}`;
const cache = resolve(".cache/compat-apps");
await mkdir(cache, { recursive: true });
const out = await mkdtemp(join(cache, "worker-upgrade-"));
const profile = join(out, "profile");
const result = { profile, origin, builds: [], rendered: [] };
const fixture = zipSync({
	"resources/app/package.json": strToU8(
		'{"name":"upgrade-counter","version":"1","main":"main.cjs"}',
	),
	"resources/app/main.cjs": strToU8(`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.whenReady().then(async () => {
  const file = '/tmp/launch-count';
  const n = 1 + (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0);
  fs.writeFileSync(file, String(n));
  fs.writeFileSync('/tmp/upgrade.html', '<!doctype html><output>Launch ' + n + '</output>');
  await new BrowserWindow().loadFile('/tmp/upgrade.html');
});`),
});

let context, page, server;
async function serve(build, delayWorker = false) {
	const bytes = await readFile(join(build, "sw.js"));
	if (!delayWorker)
		assert(!bytes.includes("persist-files"), "Seed worker already supports persistence RPCs");
	result.builds.push({
		dir: resolve(build),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	server = await preview({
		build: { outDir: resolve(build) },
		preview: { host: "127.0.0.1", port, strictPort: true },
		plugins: delayWorker
			? [
					{
						name: "delay-worker-update-fetch",
						enforce: "pre",
						configurePreviewServer(server) {
							server.middlewares.use((req, _res, next) => {
								// Widen the actual update race; never modify the worker bytes or lifecycle.
								if (req.url === "/sw.js") setTimeout(next, 1200);
								else next();
							});
						},
					},
				]
			: [],
	});
}

async function open() {
	context = await chromium.launchPersistentContext(profile, { headless: true });
	page = context.pages()[0];
	page.setDefaultTimeout(15_000);
}
async function close() {
	await context?.close();
	context = undefined;
	await server?.close();
	server = undefined;
}
async function ready() {
	await page.goto(origin);
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 22_000 });
}
async function rendered(n) {
	const frame = page.frameLocator(".runtime-window:visible > iframe");
	await expect(frame.locator("output")).toHaveText(`Launch ${n}`, { timeout: 10_000 });
	const url = await page.locator(".runtime-window:visible > iframe").getAttribute("src");
	assert.match(url, /\/__scramjet__\/.*upgrade\.html/);
	result.rendered.push({ n, url });
}
async function stop() {
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
}

function observeWorker() {
	if (window !== window.top) return;
	const previous = navigator.serviceWorker.controller;
	const trace = [];
	window.upgradeTrace = trace;
	const record = (type, worker) =>
		trace.push({
			type,
			ms: Math.round(performance.now()),
			previous: worker === previous,
			state: worker?.state,
		});
	record("open", previous);
	navigator.serviceWorker.addEventListener("controllerchange", () =>
		record("control", navigator.serviceWorker.controller),
	);
	const post = ServiceWorker.prototype.postMessage;
	ServiceWorker.prototype.postMessage = function (data, ...rest) {
		record(data?.type, this);
		return post.call(this, data, ...rest);
	};
}

try {
	await serve(oldBuild);
	await open();
	await ready();
	await page.locator("#zip-input").setInputFiles({
		name: "upgrade.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(fixture),
	});
	await rendered(1);
	result.appId = await page.locator("#application-select").inputValue();
	await stop();
	await close();

	await serve(nextBuild, true);
	await open();
	await page.addInitScript(observeWorker);
	// No registration.update(), ready/controller wait, forced reload, or second launch attempt.
	await ready();
	await page.locator("#launch-button").click();
	await rendered(2);
	assert.equal(await page.locator("#application-select").inputValue(), result.appId);
	result.trace = await page.evaluate(() => window.upgradeTrace);
	assert.equal(result.trace[0].state, "activated", "Must start under the legacy controller");
	assert(result.trace.some((e) => e.type === "control" && !e.previous));
	for (const type of ["runtime-handshake", "proxy-configure", "persist-files"]) {
		const sent = result.trace.filter((e) => e.type === type);
		assert(sent.length && sent.every((e) => !e.previous && e.state === "activated"), type);
	}
	await stop();
	await ready();
	await page.locator("#launch-button").click();
	await rendered(3);
} catch (error) {
	result.error = String(error);
	if (page && !page.isClosed()) result.trace ??= await page.evaluate(() => window.upgradeTrace);
	throw error;
} finally {
	await close();
	await writeFile(join(out, "evidence.json"), JSON.stringify(result, null, 2));
	console.log(join(out, "evidence.json"));
}
