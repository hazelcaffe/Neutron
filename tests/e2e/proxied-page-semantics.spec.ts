import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// Proxied pages must keep two browser semantics that client mods rely on to
// find their framework in a webpack bundle: `localStorage.missing` is
// undefined (a byProps filter must not match Storage), and Error.stack names
// a script by the URL it was loaded from (bundle detection by file name).
test("Storage named properties and Error.stack URLs match Chromium in a proxied page", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"page-semantics","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,protocol,net}=require('electron');
app.whenReady().then(()=>{
  protocol.handle('https', request => net.fetch('file:///app' + new URL(request.url).pathname, {bypassCustomProtocolHandlers:true}));
  new BrowserWindow().loadURL('https://semantics.invalid/index.html');
});`,
		"index.html":
			'<!doctype html><title>Semantics</title><script src="/assets/probe.js"></script>',
		"assets/probe.js": `function capture(){return new Error('probe').stack}
const results={};
results.stack=capture();
results.bundle=(results.stack.match(/\\/assets\\/(.+?\\.js)/)||[])[1];
results.thrown=(()=>{try{null.x}catch(error){return error.stack}})();
localStorage.setItem('present','1');
results.storage={
  missing:localStorage.neutronMissing,
  missingType:typeof localStorage.createElement,
  session:typeof sessionStorage.useState,
  present:localStorage.present,
  getItemIn:'getItem' in localStorage,
  presentIn:'present' in localStorage,
  absentIn:'absent' in localStorage,
  symbolIn:(()=>{try{return Symbol.iterator in localStorage}catch(error){return 'threw '+error.name}})(),
  byProps:[localStorage,sessionStorage].filter(m=>m.createElement!==void 0&&m.useEffect!==void 0).length,
};
const previous=Error.prepareStackTrace;
Error.prepareStackTrace=(_error,sites)=>sites;
const sites=new Error('sites').stack;
Error.prepareStackTrace=previous;
results.custom=Array.isArray(sites)&&typeof sites[0].getLineNumber==='function';
results.restored=capture();
document.documentElement.dataset.results=JSON.stringify(results);`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	let results: Record<string, unknown> & { storage?: unknown; stack?: string } = {};
	await expect
		.poll(async () => {
			const value = await frame
				.locator("html")
				.getAttribute("data-results", { timeout: 1000 })
				.catch(() => null);
			if (value) results = JSON.parse(value);
			return typeof results.stack;
		})
		.toBe("string");
	expect(results.storage).toEqual({
		missingType: "undefined",
		session: "undefined",
		present: "1",
		getItemIn: true,
		presentIn: true,
		absentIn: false,
		symbolIn: false,
		byProps: 0,
	});
	expect(results.stack).toMatch(
		/^Error: probe\n {4}at capture \(https:\/\/semantics\.invalid\/assets\/probe\.js:\d+:\d+\)/,
	);
	expect(results.bundle).toBe("probe.js");
	expect(results.thrown).toMatch(
		/^TypeError: .*null.*\n {4}at .*https:\/\/semantics\.invalid\/assets\/probe\.js:\d+:\d+/,
	);
	expect(results.custom).toBe(true);
	expect(results.restored).toMatch(
		/at capture \(https:\/\/semantics\.invalid\/assets\/probe\.js:/,
	);
	for (const stack of [results.stack, results.thrown, results.restored])
		expect(stack).not.toContain("__scramjet__");
});
