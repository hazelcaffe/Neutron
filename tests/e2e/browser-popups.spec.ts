import { createServer } from "node:http";
import { createAsar } from "@neutron/runtime/asar";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";

// The patterns of a vendor sign-in page (Figma's, for example) without a
// vendor or an account: in-page `href="#"` mode switches, cookies set by XHR
// responses and by document.cookie, and an OAuth popup that hands its result
// to the opener through a cookie and postMessage, then closes itself.
const login = `<!doctype html><title>Fixture login</title>
<p id="loads"></p><p id="mode">password</p><p id="hash"></p><p id="session"></p><p id="echo"></p>
<p id="result"></p><p id="message"></p><p id="noopener"></p>
<a href="#" id="sso">Use single sign-on</a>
<button id="xhr">Start session</button>
<button id="google">Continue with Google</button>
<button id="isolated">Open without opener</button>
<script>
const text = (id, value) => (document.getElementById(id).textContent = value);
sessionStorage.loads = Number(sessionStorage.loads || 0) + 1;
text("loads", "loads:" + sessionStorage.loads);
// Like a React onClick on <a href="#">: no preventDefault.
document.getElementById("sso").onclick = () => text("mode", "sso");
addEventListener("hashchange", () => text("hash", "hashchange:" + location.href.endsWith("#")));
document.getElementById("xhr").onclick = async () => {
	await fetch("/session", { method: "POST" });
	text("session", document.cookie.includes("session_csrf=fixture-csrf") ? "csrf visible" : "csrf missing");
	document.cookie = "js_choice=sso; path=/";
	text("echo", await (await fetch("/echo")).text());
};
let popup;
addEventListener("message", (event) => {
	if (event.source === popup && event.origin === location.origin) text("message", event.data);
});
document.getElementById("google").onclick = () => {
	document.cookie = "__Host-sso_temp=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; Secure";
	popup = window.open("/popup", "", "width=600,height=600");
	if (popup === null) return text("result", "window-not-found");
	const poll = () => {
		const entry = document.cookie.split("; ").find((c) => c.startsWith("__Host-sso_temp="));
		if (entry) text("result", "token:" + JSON.parse(decodeURIComponent(entry.slice(16))).token);
		else if (popup.closed) text("result", "cookie-not-found");
		else setTimeout(poll, 100);
	};
	setTimeout(poll, 100);
};
document.getElementById("isolated").onclick = () =>
	text("noopener", String(window.open("/popup?isolated", "_blank", "noopener")));
</script>`;
const popupPage = `<!doctype html><title>Fixture provider</title><p id="opener"></p><script>
document.getElementById("opener").textContent = "opener:" + (window.opener ? "present" : "none");
if (window.opener && !location.search) {
	window.opener.postMessage("hello from popup", location.origin);
	document.cookie = "__Host-sso_temp=" + encodeURIComponent(JSON.stringify({ token: "t1" })) + "; path=/; ; Secure";
	window.close();
}
</script>`;

function fixtureFrame(page: Page, port: number, path: string): Frame | undefined {
	return page.frames().find((frame) => {
		const match = /\/__scramjet__\/[^/]+\/([^?#]+)/.exec(frame.url());
		return (
			!!match?.[1] &&
			decodeURIComponent(match[1]).startsWith(`http://127.0.0.1:${port}${path}`)
		);
	});
}

test("Browser tabs support in-page fragments, shared cookies and OAuth popups", async ({
	page,
}) => {
	const fixture = createServer((req, res) => {
		if (req.url === "/session" && req.method === "POST") {
			res.writeHead(200, {
				"Set-Cookie": "session_csrf=fixture-csrf; Path=/",
				"Content-Type": "text/plain",
			});
			res.end("ok");
			return;
		}
		if (req.url === "/echo") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`cookie: ${req.headers.cookie ?? ""}`);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(req.url?.startsWith("/popup") ? popupPage : login);
	});
	await new Promise<void>((resolve, reject) =>
		fixture.once("error", reject).listen(0, "127.0.0.1", resolve),
	);
	try {
		const addr = fixture.address();
		if (!addr || typeof addr === "string") throw new Error("Missing fixture address");
		const url = `http://127.0.0.1:${addr.port}/login`;
		const archive = createAsar({
			"package.json": '{"name":"popups","version":"1","main":"main.cjs"}',
			"main.cjs": `const {app,BrowserWindow,shell,ipcMain}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});ipcMain.handle('login',()=>shell.openExternal(${JSON.stringify(url)}));w.loadFile('index.html')});`,
			"preload.cjs":
				"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('app',{login:()=>ipcRenderer.invoke('login')});",
			"index.html":
				'<!doctype html><button onclick="app.login()">Log in with browser</button>',
		});
		let pages = 0;
		page.context().on("page", () => pages++);
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		await page
			.frameLocator('iframe[data-neutron-id="1"]')
			.getByText("Log in with browser")
			.click();
		const tabs = page.locator("iframe[data-neutron-browser]");
		const browser = page.frameLocator(".runtime-window:visible iframe[data-neutron-browser]");
		await expect(browser.locator("#loads")).toHaveText("loads:1");
		// A doctype-first page without <html>/<head> tags stays in standards mode.
		expect(
			await fixtureFrame(page, addr.port, "/login")?.evaluate(() => document.compatMode),
		).toBe("CSS1Compat");

		// href="#" is a same-document fragment navigation, not a reload.
		await browser.locator("#sso").click();
		await expect(browser.locator("#hash")).toHaveText("hashchange:true");
		await expect(browser.locator("#mode")).toHaveText("sso");
		await expect(browser.locator("#loads")).toHaveText("loads:1");

		// A response's Set-Cookie is readable when its fetch resolves, and a
		// document.cookie write is sent with the next request.
		await browser.locator("#xhr").click();
		await expect(browser.locator("#session")).toHaveText("csrf visible");
		await expect(browser.locator("#echo")).toContainText("js_choice=sso");
		await expect(browser.locator("#echo")).toContainText("session_csrf=fixture-csrf");

		// window.open returns the popup: the popup sees its opener, posts to it,
		// writes the result cookie and closes; the opener reads the cookie first.
		await browser.locator("#google").click();
		await expect(browser.locator("#message")).toHaveText("hello from popup");
		await expect(browser.locator("#result")).toHaveText("token:t1");
		await expect(tabs).toHaveCount(1);

		// noopener: a new tab without an opener, and no window for the caller.
		await browser.locator("#isolated").click();
		await expect(tabs).toHaveCount(2);
		await expect(browser.locator("#opener")).toHaveText("opener:none");
		await expect(
			page.frameLocator("iframe[data-neutron-browser]").first().locator("#noopener"),
		).toHaveText("null");
		expect(pages).toBe(0);
	} finally {
		fixture.closeAllConnections();
		await new Promise<void>((done) => fixture.close(() => done()));
	}
});
