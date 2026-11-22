// Credential-free probe of GitHub Desktop's browser sign-in (Windows package,
// platform win32): the authorize URL opens in a proxied Neutron Browser tab,
// a local page then redirects to Desktop's registered callback scheme with a
// fake code and the real state, and Desktop must exchange it at
// github.com/login/oauth/access_token over Wisp. GitHub rejects the fake code
// (bad_verification_code), which proves the whole round trip without an
// account. No codes, tokens or grant URLs are written to the evidence.
//
//   NEUTRON_COMPAT_CACHE=<dir containing github-desktop/manifest.json>
//   NEUTRON_SIGNIN_PORT=<preview port> (default 4270; fixture uses port + 1)
//   NEUTRON_COMPAT_OUT=<evidence directory>
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

const cache = resolve(process.env.NEUTRON_COMPAT_CACHE || ".cache/compat-apps");
const port = Number(process.env.NEUTRON_SIGNIN_PORT || 4270);
const manifest = JSON.parse(await readFile(join(cache, "github-desktop/manifest.json")));
const root = resolve(process.env.NEUTRON_COMPAT_OUT || join(cache, "signin"));
await mkdir(root, { recursive: true });
const out = await mkdtemp(join(root, "desktop-signin-"));
await cp(resolve(process.env.NEUTRON_GIT_BUILD || "dist"), join(out, "dist"), { recursive: true });
console.log(out);
const result = { package: manifest.package, steps: [], exchange: [] };
const fixture = createServer((req, res) => {
	const url = new URL(req.url || "/", "http://fixture");
	if (url.pathname !== "/return") return void res.writeHead(404).end();
	// What github.com does after the user authorizes the OAuth app.
	const state = encodeURIComponent(url.searchParams.get("state") || "");
	res.writeHead(302, {
		Location: `x-github-desktop-auth://oauth?code=neutron-fake-code&state=${state}`,
	});
	res.end();
});
await new Promise((ok) => fixture.listen(port + 1, "127.0.0.1", ok));
const server = await preview({
	build: { outDir: join(out, "dist") },
	preview: { host: "127.0.0.1", port, strictPort: true },
});
let context, page;
try {
	context = await chromium.launchPersistentContext(join(out, "profile"), {
		headless: true,
		args: ["--disable-dev-shm-usage"],
		viewport: { width: 1440, height: 980 },
	});
	page = context.pages()[0];
	page.setDefaultTimeout(30000);
	const record = async (step) => {
		result.steps.push(step);
		console.log(step);
		await page.screenshot({
			path: join(out, `${String(result.steps.length).padStart(2, "0")}.png`),
		});
	};
	context.on("response", async (response) => {
		const target = decodeURIComponent(response.url());
		if (!target.includes("https://github.com/login/oauth/access_token")) return;
		let error = null;
		try {
			error = JSON.parse(await response.text()).error ?? null;
		} catch {
			/* Not JSON. */
		}
		result.exchange.push({
			method: response.request().method(),
			status: response.status(),
			error,
		});
	});
	await page.goto(`http://127.0.0.1:${port}/`);
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#settings-button").click();
	await page.locator("#compat-platform").selectOption("win32");
	await page.locator("#wisp-url").fill(`ws://127.0.0.1:${port}/wisp/`);
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await page.locator("#folder-input").setInputFiles(manifest.resources);
	const app = page
		.locator(".runtime-window:not(.runtime-view):visible > iframe")
		.first()
		.contentFrame();
	await app.getByRole("link", { name: "Sign in to GitHub.com" }).click({ timeout: 300000 });
	let login;
	await expect
		.poll(
			() => {
				login = page.frames().find((f) => f.url().includes("github.com%2Flogin"));
				return !!login;
			},
			{ timeout: 60000 },
		)
		.toBe(true);
	await expect(login.locator('input[name="login"]')).toBeVisible();
	const proxied = login.url();
	// /__scramjet__/<session>/<encoded target>?<scramjet flags>
	const target = new URL(
		decodeURIComponent(new URL(proxied).pathname.split("/").slice(3).join("/")),
	);
	const authorize = new URL(target.searchParams.get("return_to") || "", "https://github.com");
	result.authorize = {
		path: authorize.pathname,
		params: [...authorize.searchParams.keys()].sort(),
		scope: authorize.searchParams.get("scope"),
		redirectUri: authorize.searchParams.get("redirect_uri"),
	};
	expect(result.authorize.params).toEqual(["client_id", "scope", "state"]);
	await record(
		"Sign in opened github.com's login (authorize return_to) in a proxied Browser tab",
	);
	const state = authorize.searchParams.get("state");
	const prefix = proxied.slice(
		0,
		proxied.indexOf("/__scramjet__/") + "/__scramjet__/".length + 37,
	);
	await login.evaluate(
		(href) => {
			location.href = href;
		},
		prefix + encodeURIComponent(`http://127.0.0.1:${port + 1}/return?state=${state}`),
	);
	await expect.poll(() => result.exchange.length, { timeout: 60000 }).toBeGreaterThan(0);
	await expect(page.locator("iframe[data-neutron-browser]")).toHaveCount(0);
	expect(result.exchange[0]).toEqual({
		method: "POST",
		status: 200,
		error: "bad_verification_code",
	});
	await expect(app.getByRole("link", { name: "Sign in to GitHub.com" })).toBeEnabled();
	await record(
		"Callback reached Desktop; it exchanged the code with GitHub, which rejected the fake code",
	);
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
} catch (error) {
	result.error = String(error).replace(/code=[^&\s]+/g, "code=<redacted>");
	console.error(result.error);
	process.exitCode = 1;
} finally {
	if (page && !page.isClosed())
		await page.screenshot({ path: join(out, "final.png") }).catch(() => {});
	await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
	await context?.close();
	await server.close();
	await new Promise((ok) => fixture.close(ok));
}
