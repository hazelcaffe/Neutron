import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// Leaving the browser tab is leaving the app: BrowserWindow blurs, and comes
// back into focus on return (apps refresh state on 'focus', e.g. git status).
test("BrowserWindow blur/focus follow the page losing and regaining focus", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"focus-events","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');
app.whenReady().then(()=>{
  const w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
  const events=[];
  for(const name of ['focus','blur']) w.on(name,()=>{events.push(name);w.webContents.send('events',events.join(','))});
  w.loadFile('index.html');
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{events:f=>ipcRenderer.on('events',(_,v)=>f(v))});`,
		"index.html": `<output>none</output><script>bridge.events(v=>document.querySelector('output').textContent=v)</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const app = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(app.locator("output")).toBeAttached();
	// Headless Chromium keeps every page focused, so emulate what a real
	// browser reports when the user switches to another window and back.
	await page.evaluate(() => {
		document.hasFocus = () => false;
		dispatchEvent(new Event("blur"));
	});
	await expect(app.locator("output")).toHaveText(/(^|,)blur$/);
	await page.evaluate(() => {
		document.hasFocus = () => true;
		dispatchEvent(new Event("focus"));
	});
	await expect(app.locator("output")).toHaveText(/blur,focus$/);
	// Focus moving from the shell into an app frame is not an app switch.
	await page.evaluate(() => dispatchEvent(new Event("blur")));
	await page.waitForTimeout(300);
	await expect(app.locator("output")).toHaveText(/blur,focus$/);
});
