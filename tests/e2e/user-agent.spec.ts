import { writeFile } from "node:fs/promises";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("packaged renderer user agent is available to preload and page scripts, with scoped overrides", async ({
	page,
}, info) => {
	const archive = createAsar({
		"package.json": JSON.stringify({ name: "atlas-notes", version: "2.7.4", main: "main.cjs" }),
		"main.cjs": `const {app,BrowserWindow,ipcMain,session}=require('electron');
app.whenReady().then(async()=>{
  const win=partition=>new BrowserWindow({webPreferences:{preload:'/app/preload.cjs',partition}});
  const reports=new Map();
  function record(w){const wc=w.webContents;reports.set(wc.id,{fileArgs:process.argv.slice(1),fallback:app.userAgentFallback,session:wc.session.getUserAgent(),contents:wc.getUserAgent(),electron:process.versions.electron,chrome:process.versions.chrome})}
  ipcMain.handle('report',({sender})=>reports.get(sender.id));
  ipcMain.handle('change',({sender})=>{sender.userAgent='Changed/4'});
  const one=win('default');record(one);await one.loadFile('index.html');
  app.userAgentFallback='App/1';
  const two=win('default');record(two);await two.loadFile('index.html');
  const s=session.fromPartition('isolated');s.setUserAgent('Partition/2');
  const three=win('isolated');record(three);s.setUserAgent('Later/3');await three.loadFile('index.html');
  const four=win('isolated');const loaded=four.loadURL('file:///app/index.html',{userAgent:'Navigation/5'});record(four);await loaded;
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('sample',{preload:navigator.userAgent,chrome:process.versions.chrome,read:()=>ipcRenderer.invoke('report'),change:()=>ipcRenderer.invoke('change')});`,
		"index.html": `<!doctype html><pre id="report"></pre><button id="change">Change</button><script>
const initial=navigator.userAgent;sample.read().then(main=>document.querySelector('#report').textContent=JSON.stringify({...main,preload:sample.preload,rendererChrome:sample.chrome,page:initial}));
document.querySelector('#change').onclick=async()=>{await sample.change();document.querySelector('#change').textContent=navigator.userAgent};</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	const native = await page.evaluate(() => navigator.userAgent);
	await page.locator("#settings-button").click();
	await page.locator("#compat-platform").selectOption("darwin");
	await page.getByRole("button", { name: "Save settings" }).click();
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = (id: number) => page.frameLocator(`iframe[data-neutron-id="${id}"]`);
	const report = async (id: number) => {
		const output = frame(id).locator("#report");
		await expect(output).toContainText("preload");
		return JSON.parse((await output.textContent()) || "null");
	};
	const first = await report(1);
	expect(first.fileArgs).toEqual([]);
	const nativeChrome = /(?:Chrome|Chromium)\/([\d.]+)/.exec(native)?.[1];
	if (nativeChrome) expect(first.chrome).toBe(nativeChrome);
	expect(first.page).toMatch(
		/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) atlas-notes\/2\.7\.4 Chrome\/[\d.]+ Electron\/[\d.]+ Safari\/[\d.]+$/,
	);
	expect(first.page).toContain(` Chrome/${first.chrome} Electron/${first.electron} `);
	expect(first).toMatchObject({
		fallback: first.page,
		session: first.page,
		contents: first.page,
		preload: first.page,
		rendererChrome: first.chrome,
	});
	const overrides = [await report(2), await report(3), await report(4)];
	for (const [index, expected] of ["App/1", "Partition/2", "Navigation/5"].entries())
		expect(overrides[index]).toMatchObject({
			fallback: "App/1",
			contents: expected,
			page: expected,
			preload: expected,
			rendererChrome: first.chrome,
		});
	expect(overrides.map((value) => value.session)).toEqual(["App/1", "Partition/2", "Later/3"]);
	await frame(4).getByRole("button", { name: "Change" }).click();
	await expect(frame(4).locator("#change")).toHaveText("Changed/4");
	expect(await page.evaluate(() => navigator.userAgent)).toBe(native);
	await writeFile(
		info.outputPath("observed-user-agents.json"),
		JSON.stringify([first, ...overrides], null, 2),
	);
});
