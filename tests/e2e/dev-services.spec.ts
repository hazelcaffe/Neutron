import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

const execute = promisify(execFile);
test("server supplies a relay automatically and Electron net.request honors options.url", async ({
	page,
	request,
}) => {
	expect(await (await request.get("/__neutron_dev__")).json()).toEqual({ wisp: "/wisp/" });
	const archive = createAsar({
		"package.json": '{"name":"automatic-network","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,net}=require('electron');app.whenReady().then(async()=>{
const data=await new Promise((resolve,reject)=>{const request=net.request({url:'http://127.0.0.1:4175/api',method:'GET',redirect:'follow'});request.on('error',reject);request.on('response',res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(Buffer.concat(chunks).toString()));});request.end();});
const w=new BrowserWindow();await w.loadFile('index.html');await w.webContents.executeJavaScript('document.body.textContent='+JSON.stringify(data));}).catch(console.error);`,
		"index.html": "<html><head><title>Automatic relay</title></head><body></body></html>",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator("iframe[data-neutron-id='1']").locator("body")).toContainText(
		"through-wisp",
	);
});

test("libcurl rejects an HTML asset without poisoning the next initialization", async ({
	page,
}) => {
	let intercepted = 0;
	await page.route("**/vendor/libcurl/libcurl.wasm", (route) => {
		if (++intercepted === 1)
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<!doctype html><title>Wrong asset</title>",
			});
		return route.continue();
	});
	const archive = createAsar({
		"package.json": '{"name":"wasm-retry","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,net}=require('electron');app.whenReady().then(async()=>{let first='';try{await net.fetch('http://127.0.0.1:4175/api');}catch(error){first=error.message;}const next=await(await net.fetch('http://127.0.0.1:4175/api')).json();const w=new BrowserWindow();await w.loadFile('index.html');await w.webContents.executeJavaScript('document.body.textContent='+JSON.stringify(first+' '+next.message));}).catch(console.error);`,
		"index.html": "<html><head><title>WASM retry</title></head><body></body></html>",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const body = page.frameLocator("iframe[data-neutron-id='1']").locator("body");
	await expect(body).toContainText("ERR_RUNTIME_ASSET");
	await expect(body).toContainText("through-wisp");
	expect(intercepted).toBe(2);
});

test("dev asset rebuilds keep WASM binary and never fall back to index.html", async ({
	request,
}) => {
	test.skip(
		!process.env.NEUTRON_TEST_DEV,
		"Run with NEUTRON_TEST_DEV=1 to exercise Vite's live public-file handling.",
	);
	const check = async () => {
		const response = await request.get("/vendor/libcurl/libcurl.wasm");
		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toBe("application/wasm");
		expect([...(await response.body()).subarray(0, 4)]).toEqual([0, 97, 115, 109]);
	};
	await check();
	await Promise.all([
		execute(process.execPath, ["packages/runtime/scripts/assets.mjs"], { cwd: process.cwd() }),
		check(),
		check(),
	]);
	await check();
	const missing = await request.get("/vendor/libcurl/not-found.wasm");
	expect(missing.status()).toBe(404);
	expect(missing.headers()["content-type"]).toBe("text/plain");
});
