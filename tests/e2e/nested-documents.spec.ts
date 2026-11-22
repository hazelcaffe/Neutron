import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("nested URL and srcdoc frames use the app protocol without starting an Electron preload or database", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const archive = createAsar({
		"package.json": '{"name":"embedded-content","main":"main.cjs","version":"1"}',
		"main.cjs": `const {app,BrowserWindow,protocol,net}=require('electron');app.whenReady().then(()=>{protocol.handle('https',r=>net.fetch('file:///app'+new URL(r.url).pathname));new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}}).loadURL('https://embed.invalid/main.html');});`,
		"preload.cjs": `require('electron').contextBridge.exposeInMainWorld('desktopReady',true);`,
		"main.html": `<!doctype html><body><b id="main"></b><iframe id="regular" src="child.html"></iframe><iframe id="inline"></iframe><script>document.querySelector('#main').textContent=[typeof desktopReady,typeof __neutronSQLite].join(',');document.querySelector('#inline').srcdoc='<output id="data"></output><script src="https://embed.invalid/report.js"><\\/script>';</script>`,
		"child.html": `<!doctype html><output id="data"></output><script src="report.js"></script>`,
		"report.js": `(async()=>{const r=await fetch('https://embed.invalid/value.txt');document.getElementById('data').textContent=[await r.text(),typeof desktopReady,typeof __neutronSQLite].join(',')})()`,
		"value.txt": "packaged value",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.locator("#main")).toHaveText("boolean,object");
	await expect(frame.frameLocator("#inline").locator("#data")).toHaveText(
		"packaged value,undefined,undefined",
	);
	await expect(frame.frameLocator("#regular").locator("#data")).toHaveText(
		"packaged value,undefined,undefined",
	);
	expect(errors).toEqual([]);
});
