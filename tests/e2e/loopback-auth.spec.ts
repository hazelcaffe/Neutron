import { createServer } from "node:http";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("a hosted provider's 307 preserves the POST to the app's ephemeral HTTP callback", async ({
	page,
	context,
}) => {
	let callbackOrigin = "";
	// Only the synthetic provider opens a test socket. Its return URL is learned
	// from the imported guest, just like any provider receiving a redirect URI.
	const provider = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/start") {
			const redirect = URL.parse(url.searchParams.get("redirect_uri") ?? "");
			if (
				redirect?.protocol !== "http:" ||
				redirect.hostname !== "127.0.0.1" ||
				!redirect.port
			) {
				res.writeHead(400).end();
				return;
			}
			callbackOrigin = redirect.origin;
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Set-Cookie": "calendar_fixture=local; Path=/",
			});
			res.end(
				'<!doctype html><h1>Local identity fixture</h1><form method="POST" action="/return"><input type="hidden" name="receipt" value="fixture +/&amp;"><button>Return to application</button></form>',
			);
		} else if (url.pathname === "/return" && req.method === "POST" && callbackOrigin) {
			res.writeHead(307, {
				Location: `${callbackOrigin}/done?state=fixture%2Bstate&n=1&n=2`,
			}).end();
		} else res.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) =>
		provider
			.once("error", reject)
			.listen(Number(process.env.NEUTRON_LOOPBACK_FIXTURE_PORT || 0), "127.0.0.1", resolve),
	);
	try {
		const addr = provider.address();
		if (!addr || typeof addr === "string") throw new Error("Missing provider address");
		const archive = createAsar({
			"package.json": '{"name":"calendar-fixture","version":"1","main":"main.cjs"}',
			"main.cjs": `
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('node:http');
app.whenReady().then(() => {
  const w = new BrowserWindow({ webPreferences: { preload: '/app/preload.cjs' } });
  ipcMain.handle('launch', () => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', b => chunks.push(b));
      req.on('end', () => {
        const observed = {method:req.method, url:req.url, host:req.headers.host, cookie:req.headers.cookie, contentType:req.headers['content-type'], body:Buffer.concat(chunks).toString(), complete:req.complete};
        res.on('finish', () => { observed.finished = true });
        server.close(() => w.webContents.send('observed', {...observed, closed:!server.listening && server.address() === null}));
        res.writeHead(201, 'Fixture Accepted', {'Content-Type':'text/html', 'X-Callback-Receipt':'synthetic'});
        res.write('<!doctype html><h1>Application');
        setTimeout(() => res.end(' received the return</h1>'), 10);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const url = new URL('http://127.0.0.1:${addr.port}/start');
      url.searchParams.set('redirect_uri', 'http://127.0.0.1:' + server.address().port + '/done');
      shell.openExternal(url.href);
    });
  });
  w.loadFile('index.html');
});`,
			"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('calendar',{launch:()=>ipcRenderer.invoke('launch'),receive:fn=>ipcRenderer.on('observed',(_,v)=>fn(v))});`,
			"index.html": `<!doctype html><button onclick="calendar.launch()">Open local provider</button><output></output><script>calendar.receive(v=>document.querySelector('output').textContent=JSON.stringify(v))</script>`,
		});
		await page.goto("/");
		await context.addCookies([
			{ name: "neutron_test_shell", value: "must-not-arrive", url: page.url() },
		]);
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		const app = page.frameLocator('iframe[data-neutron-id="1"]');
		await app.getByRole("button", { name: "Open local provider" }).click();
		const browser = page.frameLocator("iframe[data-neutron-browser]");
		await expect(browser.getByRole("heading")).toHaveText("Local identity fixture");
		const callbackURL = `${callbackOrigin}/done?state=fixture%2Bstate&n=1&n=2`;
		// Possessing the URL outside the hosted session doesn't grant access.
		const src = await page.locator("iframe[data-neutron-browser]").getAttribute("src");
		if (!src) throw new Error("Missing browser session URL");
		const copied = src.slice(0, src.lastIndexOf("/") + 1) + encodeURIComponent(callbackURL);
		expect(await page.evaluate(async (url) => (await fetch(url)).status, copied)).toBe(403);
		await expect(app.locator("output")).toBeEmpty();
		const response = page.waitForResponse((r) =>
			r.url().includes(encodeURIComponent(callbackURL)),
		);
		await browser.getByRole("button", { name: "Return to application" }).click();
		await expect(browser.getByRole("heading")).toHaveText("Application received the return");
		const receipt = await response;
		expect(receipt.fromServiceWorker()).toBe(true);
		expect(receipt.status()).toBe(201);
		expect(receipt.statusText()).toBe("Fixture Accepted");
		expect(receipt.headers()["x-callback-receipt"]).toBe("synthetic");
		await expect(app.locator("output")).toContainText('"closed":true');
		expect(JSON.parse((await app.locator("output").textContent()) ?? "")).toEqual({
			method: "POST",
			url: "/done?state=fixture%2Bstate&n=1&n=2",
			host: new URL(callbackOrigin).host,
			cookie: "calendar_fixture=local",
			contentType: "application/x-www-form-urlencoded",
			body: "receipt=fixture+%2B%2F%26",
			complete: true,
			finished: true,
			closed: true,
		});
		expect(context.pages()).toHaveLength(1);
		// A late request to the closed binding must not fall through to the relay.
		expect(
			await browser.locator("body").evaluate(async () => (await fetch("/done")).status),
		).toBe(410);
	} finally {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
	}
});
