// Opt in from the repo root: node tests/compat/insomnia-local.mjs [--post]
// Requires the cached Linux 13.4.0 package and existing production dist. No rebuild or sweep.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

const cache = resolve(process.env.NEUTRON_APP_CACHE || ".cache/compat-apps");
const manifest = JSON.parse(await readFile(join(cache, "insomnia/manifest.json"), "utf8"));
if (manifest.status !== "ready" || manifest.package?.version !== "13.4.0") {
	throw new Error("Expected a ready Insomnia 13.4.0 Linux resources manifest.");
}
const out = await mkdtemp(join(cache, "insomnia-local-probe-"));
const build = resolve(process.env.NEUTRON_INSOMNIA_BUILD || "dist");
// Optional closed profile from a completed import, before onboarding. Copy
// only its persistent file store; never launch or update the source profile.
const seed = process.env.NEUTRON_INSOMNIA_PROFILE;
const id = randomUUID();
const fixtureURL = `http://127.0.0.1:4213/check/${id}`;
// Only the fixture knows this response; it cannot match the request URL or editor input.
const expected = `fixture-response-${randomUUID()}`;
const verifyPost = process.argv.includes("--post");
const postBody = `posted from Scratch Pad: ${randomUUID()}`;
const postResponse = `fixture-accepted-${randomUUID()}`;
const hits = [];
const result = {
	build,
	package: manifest.package,
	sha256: manifest.sha256,
	fixtureURL,
	expected,
	...(verifyPost ? { postBody, postResponse } : {}),
	hits,
	verified: [],
};
const fixture = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = Buffer.concat(chunks).toString("utf8");
	hits.push({ method: req.method, path: req.url, body, at: new Date().toISOString() });
	const pathMatches = req.url === new URL(fixtureURL).pathname;
	const get = pathMatches && req.method === "GET";
	const post = verifyPost && pathMatches && req.method === "POST" && body === postBody;
	res.writeHead(post ? 201 : get ? 200 : 404, {
		"Content-Type": "text/plain",
		"Cache-Control": "no-store",
	});
	res.end(post ? postResponse : get ? expected : "Not found");
});

let server;
let context;
let page;
let app;
// biome-ignore lint/performance/useDomNodeTextContent: Diagnostic artifacts should contain rendered UI text, not hidden markup or script source.
const rendered = (locator) => locator.innerText({ timeout: 3000 });
const record = (step) => {
	result.verified.push(step);
	console.log(step);
};
async function openProfile() {
	context = await chromium.launchPersistentContext(join(out, "profile"), {
		headless: true,
		viewport: { width: 1440, height: 1000 },
		args: ["--disable-dev-shm-usage"],
	});
	page = context.pages()[0];
	page.setDefaultTimeout(15000);
	await page.goto("http://127.0.0.1:4211/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 30000 });
}
console.log(`Artifacts: ${out}`);
try {
	await new Promise((ok, fail) => fixture.once("error", fail).listen(4213, "127.0.0.1", ok));
	const copy = { recursive: true, mode: constants.COPYFILE_FICLONE };
	await cp(build, join(out, "dist"), copy);
	if (seed)
		for (const store of ["File System", "WebStorage"]) {
			await cp(join(seed, "Default", store), join(out, "profile/Default", store), copy);
		}
	server = await preview({
		build: { outDir: join(out, "dist") },
		preview: { host: "127.0.0.1", port: 4211, strictPort: true },
	});
	await openProfile();
	await page.locator("#settings-button").click();
	await page.locator("#compat-platform").selectOption("linux");
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4211/wisp/");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	if (!seed) await page.locator("#folder-input").setInputFiles(manifest.resources);
	await expect(page.locator("#application-select option")).toContainText("Insomnia", {
		timeout: 600000,
	});
	await expect(page.locator("#import-progress")).toBeHidden({ timeout: 600000 });
	record(
		seed
			? "Opened a private copy of the imported Insomnia 13.4.0 profile"
			: "Imported Insomnia 13.4.0 into a fresh private profile",
	);
	// Reopen after the 1.3 GiB import so Chromium can release the import buffers before launch.
	await context.close();
	await openProfile();
	await page.locator("#launch-button").click();
	app = page
		.locator(".runtime-window:not(.runtime-view):visible > iframe")
		.first()
		.contentFrame();
	const button = (name) => app.getByRole("button", { name, exact: true });
	const proceed = app.getByRole("link", { name: "Continue", exact: true });
	await proceed.waitFor({ timeout: 360000 });
	await proceed.click();
	// A cold route loads dozens of packaged JS chunks in the emulated browser window.
	const routeTimeout = 180000;
	await button("Use local Scratch Pad").click({ timeout: routeTimeout });
	const tutorial = app.getByRole("dialog", { name: "Sidebar focus mode onboarding" });
	await tutorial.getByRole("button", { name: "Got It" }).click({ timeout: routeTimeout });
	await button("Dismiss tutorial").click();
	await button("Back to all projects").click();
	const tree = app.getByRole("grid", { name: "Project Navigation Tree" });
	await expect(tree.getByRole("row", { name: "Scratch Pad", exact: true })).toBeVisible();
	record("Opened the built-in Scratch Pad collection in the account-free project tree");
	await button("Create in empty API collection").click();
	await app.getByRole("menuitemradio", { name: "HTTP Request", exact: true }).click();
	await expect(tree.getByRole("row", { name: "New Request", exact: true })).toBeVisible({
		timeout: routeTimeout,
	});
	await expect(button("Request Method")).toContainText("GET", { timeout: routeTimeout });
	record("Created an HTTP request in Scratch Pad; method is GET");
	const url = app
		.locator(".CodeMirror")
		.filter({ hasText: "https://api.myproduct.com/v1/users" })
		.locator("textarea");
	await url.press("Control+a");
	await page.keyboard.insertText(fixtureURL);
	await page.keyboard.press("Tab");
	await expect(app.getByRole("tabpanel", { name: "Params" })).toContainText(fixtureURL, {
		useInnerText: true,
		timeout: 15000,
	});
	await page.screenshot({ path: join(out, "request.png") });
	await button("Send").click();
	record("Confirmed fixture URL in URL Preview and clicked Send");
	const response = app.getByRole("tabpanel", { name: "Preview" });
	await expect(response).toBeVisible({ timeout: 45000 });
	const responseText = await rendered(response);
	if (/^Error$/m.test(responseText))
		throw new Error(`Insomnia response Preview: Error; ${hits.length} fixture hit(s)`);
	await expect(response).toContainText(expected, { useInnerText: true, timeout: 30000 });
	expect(hits).toContainEqual(
		expect.objectContaining({ method: "GET", path: new URL(fixtureURL).pathname }),
	);
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	record("Fixture received the matching GET and Insomnia displayed its unique response body");
	if (verifyPost) {
		await button("Request Method").click();
		await app.getByText("POST", { exact: true }).filter({ visible: true }).first().click();
		await expect(button("Request Method")).toHaveText("POST");
		await app.getByRole("tab", { name: "Body", exact: true }).click();
		const bodyPanel = app.getByRole("tabpanel", { name: "Body", exact: true });
		await bodyPanel
			.getByRole("button")
			.filter({ hasText: /No Body/i })
			.click();
		await app
			.getByText("Plain Text", { exact: true })
			.filter({ visible: true })
			.first()
			.click();
		await bodyPanel.locator(".CodeMirror").click();
		await page.keyboard.insertText(postBody);
		await expect(bodyPanel.locator(".CodeMirror")).toContainText(postBody);
		await app.getByRole("tab", { name: "Params", exact: true }).click();
		// The editor debounces updates. Wait for the application to commit
		// the request model; an immediate Send can legitimately use the prior
		// (empty) body. Read only this test profile, and never change app data.
		const appId = await page.locator("#application-select").inputValue();
		await expect
			.poll(
				() =>
					page.evaluate(
						async ({ appId, fixtureURL, postBody }) => {
							let dir = await navigator.storage.getDirectory();
							for (const part of [
								"neutron",
								"apps",
								appId,
								"fs",
								"home",
								"user",
								".config",
								"Insomnia",
							])
								dir = await dir.getDirectoryHandle(part);
							const file = await (
								await dir.getFileHandle("insomnia.Request.db")
							).getFile();
							const records = (await file.text()).trimEnd().split("\n");
							for (let i = records.length - 1; i >= 0; i--) {
								try {
									const r = JSON.parse(records[i]);
									if (r.url === fixtureURL)
										return r.method === "POST" && r.body?.text === postBody;
								} catch {
									/* partial/metadata record */
								}
							}
							return false;
						},
						{ appId, fixtureURL, postBody },
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		record("The request editor persisted the plain-text POST body");
		await button("Send").click();
		await expect(response).toContainText(postResponse, { useInnerText: true, timeout: 45_000 });
		expect(hits).toContainEqual(
			expect.objectContaining({
				method: "POST",
				path: new URL(fixtureURL).pathname,
				body: postBody,
			}),
		);
		record(
			"Fixture received the matching POST body and Insomnia displayed the 201 response payload",
		);
	}
} catch (error) {
	result.error = String(error);
	console.error(result.error);
	process.exitCode = 1;
} finally {
	try {
		if (page && !page.isClosed()) {
			await page
				.screenshot({ path: join(out, "final.png"), timeout: 10000 })
				.catch((error) => {
					result.screenshotError = String(error);
				});
			result.state = await page.locator("#runtime-state").textContent();
			result.frames = await Promise.all(
				page
					.frames()
					.slice(1)
					.map(async (f) => ({
						url: f.url(),
						text: await rendered(f.locator("body")).catch(() => null),
					})),
			);
			const consoleTab = app?.getByRole("tab", { name: "Console", exact: true });
			if (result.error && (await consoleTab?.isVisible())) {
				await consoleTab.click();
				result.requestConsole = await rendered(
					app.getByRole("tabpanel", { name: "Console" }),
				);
			}
			if ((await page.locator("#logs-button").getAttribute("aria-pressed")) !== "true")
				await page.locator("#logs-button").click({ timeout: 3000 });
			await writeFile(
				join(out, "runtime-console.txt"),
				await rendered(page.locator("#console-output")),
			);
		}
	} catch (error) {
		result.diagnosticError = String(error);
	} finally {
		await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
		await context?.close();
		await server?.close();
		if (fixture.listening) await new Promise((ok) => fixture.close(ok));
	}
}
