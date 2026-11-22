import { createServer } from "node:http";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("system-browser sign-in stays proxied and returns a registered deep link to the existing app", async ({
	page,
	context,
}) => {
	const callback = "quill-demo://finish?code=sample%2Bvalue&state=fixture#receipt";
	const fixture = createServer((req, res) => {
		if (req.url === "/return") {
			res.writeHead(302, { Location: callback });
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(
			`<!doctype html><title>Fixture identity service</title><h1>Fixture sign in</h1><div id="env"></div><script>document.querySelector('#env').textContent=[typeof require,typeof process,typeof appOnly].join(',')</script><a href="/return">Return to app</a><button onclick="window.open('/child','_blank')">Additional site</button><a href="nobody-here://finish">Unregistered handler</a>`,
		);
	});
	await new Promise<void>((resolve, reject) =>
		fixture.once("error", reject).listen(0, "127.0.0.1", resolve),
	);
	try {
		const addr = fixture.address();
		if (!addr || typeof addr === "string") throw new Error("Missing fixture address");
		const url = `http://127.0.0.1:${addr.port}/login`;
		const archive = createAsar({
			"package.json": '{"name":"quill","version":"1","main":"main.cjs"}',
			"main.cjs": `const {app,BrowserWindow,shell,ipcMain}=require('electron');let w;app.whenReady().then(()=>{w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});app.setAsDefaultProtocolClient('quill-demo');app.once('open-url',(event,target)=>w.webContents.send('back','url: '+target));app.requestSingleInstanceLock();let n=0;app.on('second-instance',(_e,argv)=>w.webContents.send('back',(++n)+' instance: '+argv.at(-1)));ipcMain.handle('login',()=>shell.openExternal(${JSON.stringify(url)}));w.loadFile('index.html')});`,
			"preload.cjs": `const {contextBridge,ipcRenderer,shell}=require('electron');contextBridge.exposeInMainWorld('appOnly',{login:()=>ipcRenderer.invoke('login'),rendererLogin:()=>shell.openExternal(${JSON.stringify(url)}),receive:func=>ipcRenderer.on('back',(_,v)=>func(v))});`,
			"index.html": `<!doctype html><button onclick="appOnly.login()">Sign in with browser</button><button onclick="appOnly.rendererLogin()">Open from preload</button><output></output><script>appOnly.receive(v=>document.querySelector('output').textContent=v)</script>`,
		});
		let popups = 0;
		context.on("page", () => popups++);
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		const app = page.frameLocator('iframe[data-neutron-id="1"]');
		await app.getByText("Sign in with browser").click();
		const browser = page.frameLocator(".runtime-window:visible iframe[data-neutron-browser]");
		await expect(browser.getByRole("heading")).toHaveText("Fixture sign in");
		await expect(browser.locator("#env")).toHaveText("undefined,undefined,undefined");
		await expect(page.locator("iframe[data-neutron-browser]")).toHaveAttribute(
			"src",
			/\/__scramjet__\//,
		);
		await browser.getByText("Additional site").click();
		await expect(page.locator("iframe[data-neutron-browser]")).toHaveCount(2);
		await expect(browser.getByRole("heading")).toHaveText("Fixture sign in");
		await browser.getByText("Unregistered handler").click();
		await expect(app.locator("output")).toBeEmpty();
		await expect(page.locator(".window-tab[data-state='failed'] [role='tab']")).toHaveAttribute(
			"title",
			/No registered application handler/,
		);
		await page
			.locator('.window-tab[aria-current], .window-tab:has([aria-selected="true"])')
			.getByRole("button", { name: /close/i })
			.click();
		await browser.getByText("Return to app").click();
		// Linux delivers the link as the running single instance's argv (macOS
		// open-url delivery is covered by protocol-launch.spec.ts).
		await expect(app.locator("output")).toHaveText(`1 instance: ${callback}`);
		await expect(app.getByText("Sign in with browser")).toBeVisible();
		await expect(page.locator("iframe[data-neutron-browser]")).toHaveCount(0);
		await app.getByText("Open from preload").click();
		await browser.getByText("Return to app").click();
		await expect(app.locator("output")).toHaveText(`2 instance: ${callback}`);
		expect(popups).toBe(0);
	} finally {
		fixture.closeAllConnections();
		await new Promise<void>((done) => fixture.close(() => done()));
	}
});
