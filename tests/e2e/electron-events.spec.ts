import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("window IPC scopes, delayed sync replies and console events follow Electron contracts", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"event-contracts","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain}=require('electron');
ipcMain.handle('which',()=> 'global');
app.whenReady().then(()=>{
  const first = new BrowserWindow({show:false,webPreferences:{preload:'/app/preload.cjs'}});
  const second = new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
  second.webContents.ipc.handle('which',()=> 'window');
  second.webContents.mainFrame.ipc.handleOnce('which',()=> 'frame');
  second.webContents.ipc.on('delayed', event => {setTimeout(()=>{event.returnValue='callback reply'},30)});
  second.webContents.on('console-message',(event,level,message)=>{
    if(message==='submit-form') second.webContents.send('console-result',{message,level,modern:event.message});
  });
  first.loadFile('index.html');second.loadFile('index.html');
});`,
		"preload.cjs": `const {ipcRenderer,contextBridge}=require('electron');
contextBridge.exposeInMainWorld('bridge',{
 which:()=>ipcRenderer.invoke('which'),
 delayed:()=>ipcRenderer.sendSync('delayed'),
 listen:fn=>ipcRenderer.on('console-result',(_event,value)=>fn(value))
});`,
		"index.html": `<html><body><button id="go">Go</button><pre id="result"></pre><pre id="console"></pre><script>
bridge.listen(value=>document.querySelector('#console').textContent=JSON.stringify(value));
document.querySelector('#go').onclick=async()=>{
 const values=[await bridge.which(),await bridge.which(),bridge.delayed()];
 document.querySelector('#result').textContent=values.join(',');console.log('submit-form');
};</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="2"]');
	await frame.locator("#go").click();
	await expect(frame.locator("#result")).toHaveText("frame,window,callback reply");
	await expect(frame.locator("#console")).toHaveText(
		JSON.stringify({ message: "submit-form", level: 1, modern: "submit-form" }),
	);
});

test("closing the setup window and creating its replacement does not quit the app", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"window-handoff","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');
app.on('window-all-closed',()=>app.quit());
app.whenReady().then(()=>{
  const first=new BrowserWindow();first.loadFile('setup.html');
  first.webContents.on('console-message',event=>{
    if(event.message!=='next')return;
    first.close(); const next=new BrowserWindow(); next.loadFile('editor.html');
  });
});`,
		"setup.html": `<button onclick="console.log('next')">Continue</button>`,
		"editor.html": `<input aria-label="Name"><button onclick="window.close()">Done</button>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await page.frameLocator('iframe[data-neutron-id="1"]').getByText("Continue").click();
	const next = page.frameLocator('iframe[data-neutron-id="2"]');
	await next.getByLabel("Name").fill("replacement");
	await expect(next.getByLabel("Name")).toHaveValue("replacement");
	await next.getByText("Done").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
});
