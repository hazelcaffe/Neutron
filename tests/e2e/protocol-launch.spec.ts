import { createServer } from "node:http";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { saveSettings } from "./shell";

// A registered-scheme link reaches a running app the way each OS delivers it:
// macOS emits open-url; Windows runs the registered command line
// (`exe <args from setAsDefaultProtocolClient> url`) and Linux runs `exe url`,
// which a single-instance app receives as second-instance argv.
const cases = [
	{ platform: "win32", expected: "second-instance /neutron/electron|--protocol-launcher|LINK" },
	{ platform: "linux", expected: "second-instance /neutron/electron|LINK" },
	{ platform: "darwin", expected: "open-url LINK" },
] as const;

for (const { platform, expected } of cases)
	test(`delivers a browser sign-in callback to a running ${platform} app`, async ({ page }) => {
		const link = "quill-launch://oauth?code=fixture-code&state=abc123";
		const fixture = createServer((req, res) => {
			if (req.url === "/return") res.writeHead(302, { Location: link }).end();
			else
				res.writeHead(200, { "Content-Type": "text/html" }).end(
					'<!doctype html><title>Fixture login</title><a href="/return">Authorize</a>',
				);
		});
		await new Promise<void>((ok) => fixture.listen(0, "127.0.0.1", ok));
		try {
			const address = fixture.address() as { port: number };
			const login = `http://127.0.0.1:${address.port}/login`;
			const archive = createAsar({
				"package.json": '{"name":"quill-launch","version":"1","main":"main.cjs"}',
				"main.cjs": `const {app,BrowserWindow,ipcMain,shell}=require('electron');let w;
if(!app.requestSingleInstanceLock()) app.quit();
app.on('will-finish-launching',()=>app.on('open-url',(e,url)=>{e.preventDefault();w.webContents.send('back','open-url '+url)}));
app.on('second-instance',(e,argv)=>w.webContents.send('back','second-instance '+argv.join('|')));
app.whenReady().then(()=>{
  app.setAsDefaultProtocolClient('quill-launch',process.execPath,['--protocol-launcher']);
  w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
  ipcMain.handle('login',()=>shell.openExternal(${JSON.stringify(login)}));
  w.loadFile('index.html');
});`,
				"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{login:()=>ipcRenderer.invoke('login'),receive:f=>ipcRenderer.on('back',(_,v)=>f(v))});`,
				"index.html": `<button onclick="bridge.login()">Sign in</button><output></output><script>bridge.receive(v=>document.querySelector('output').textContent=v)</script>`,
			});
			await page.goto("/");
			await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
			await page.locator("#settings-button").click();
			await page.locator("#compat-platform").selectOption(platform);
			await saveSettings(page);
			await page.locator("#zip-input").setInputFiles({
				name: "resources.zip",
				mimeType: "application/zip",
				buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
			});
			const app = page.frameLocator('iframe[data-neutron-id="1"]');
			await app.getByText("Sign in").click();
			const browser = page.frameLocator(
				".runtime-window:visible iframe[data-neutron-browser]",
			);
			await browser.getByText("Authorize").click();
			await expect(app.locator("output")).toHaveText(expected.replace("LINK", link));
			await expect(page.locator("iframe[data-neutron-browser]")).toHaveCount(0);
		} finally {
			fixture.closeAllConnections();
			await new Promise<void>((done) => fixture.close(() => done()));
		}
	});
