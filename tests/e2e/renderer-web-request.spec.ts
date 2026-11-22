import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { saveSettings } from "./shell";

// session.webRequest.onHeadersReceived also applies to the renderer's own
// documents and subresources, before the browser interprets the response.
test("webRequest.onHeadersReceived changes and cancels renderer responses", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"renderer-headers","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,session,ipcMain}=require('electron');
const seen=[];
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onHeadersReceived({urls:['http://127.0.0.1:4175/*']},(details,callback)=>{
    const path=new URL(details.url).pathname;
    const headers={...details.responseHeaders};
    const type=Object.keys(headers).find(name=>name.toLowerCase()==='content-type');
    seen.push([path,details.method,details.resourceType,details.statusCode,headers[type]?.[0]]);
    if(path==='/blocked') return callback({cancel:true});
    if(path==='/plain-page'||path==='/plain.css') headers[type]=[path==='/plain.css'?'text/css':'text/html'];
    callback({responseHeaders:headers});
  });
  ipcMain.handle('seen',()=>seen);
  await new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}}).loadURL('http://127.0.0.1:4175/plain-page');
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('seen',()=>ipcRenderer.invoke('seen'));`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#settings-button").click();
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4174/wisp/");
	await saveSettings(page);
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.locator("#filtered")).toHaveText("Rendered as HTML", { timeout: 25_000 });
	await expect(frame.locator("#filtered")).toHaveCSS("color", "rgb(1, 2, 3)");
	await expect(frame.locator("body")).toHaveAttribute("data-blocked", "blocked");
	const seen = await frame.locator("body").evaluate(() => Reflect.get(window, "seen")());
	expect(seen).toEqual(
		expect.arrayContaining([
			["/plain-page", "GET", "mainFrame", 200, "text/plain"],
			["/plain.css", "GET", "stylesheet", 200, "text/plain"],
			["/blocked", "GET", "xhr", 200, "text/html"],
		]),
	);
});
