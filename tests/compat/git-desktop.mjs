// Drive the official GitHub Desktop (Windows package, platform win32) through
// its main Git workflows against a local smart-HTTP + Git LFS origin:
// onboarding (git lfs install), URL clone with an LFS file, changes list and
// diff, commit, history, new branch + publish, push, and a remote URL change.
// Runs against a private snapshot of dist with a new browser profile.
//
//   NEUTRON_COMPAT_CACHE=<dir containing github-desktop/manifest.json>
//   NEUTRON_GIT_PORT=<preview port> (default 4260)
//   NEUTRON_COMPAT_OUT=<evidence directory> (default <cache>/git-ui)
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { startGitServer } from "../../packages/runtime/tests/git-server-fixture.ts";

const cache = resolve(process.env.NEUTRON_COMPAT_CACHE || ".cache/compat-apps");
const port = Number(process.env.NEUTRON_GIT_PORT || 4260);
const manifest = JSON.parse(await readFile(join(cache, "github-desktop/manifest.json")));
const root = resolve(process.env.NEUTRON_COMPAT_OUT || join(cache, "git-ui"));
await mkdir(root, { recursive: true });
const out = await mkdtemp(join(root, "desktop-"));
const build = resolve(process.env.NEUTRON_GIT_BUILD || "dist");
await cp(build, join(out, "dist"), { recursive: true });
console.log(out);

// Seed the origin: hello.txt plus an LFS-tracked asset.bin.
const origin = await startGitServer(join(out, "origin"));
const asset = Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7) % 256));
const assetOid = createHash("sha256").update(asset).digest("hex");
origin.lfsObjects.set(assetOid, asset);
const lfsFiles = {
	".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
	"asset.bin": `version https://git-lfs.github.com/spec/v1\noid sha256:${assetOid}\nsize ${asset.length}\n`,
};
await origin.seed("demo", [
	{ message: "Initial fixture", files: { ...lfsFiles, "hello.txt": "one\n" } },
	{
		message: "Second fixture commit",
		files: { ...lfsFiles, "hello.txt": "two revisions via smart HTTP\n" },
	},
]);
const repoURL = origin.url("demo");
const result = { build, package: manifest.package, sha256: manifest.sha256, steps: [], events: [] };
const event = (kind, data) => result.events.push({ time: Date.now(), kind, data });
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
	page.setDefaultTimeout(25000);
	page.on("pageerror", (e) => event("pageerror", e.stack));
	page.on("console", (m) => {
		if (["error", "warning"].includes(m.type())) event(m.type(), m.text().slice(0, 2000));
	});
	await page.goto(`http://127.0.0.1:${port}/`);
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 30000 });
	await page.locator("#settings-button").click();
	await page.locator("#compat-platform").selectOption("win32");
	await page.locator("#wisp-url").fill(`ws://127.0.0.1:${port}/wisp/`);
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await page.locator("#folder-input").setInputFiles(manifest.resources);
	const app = page
		.locator(".runtime-window:not(.runtime-view):visible > iframe")
		.first()
		.contentFrame();
	const renderer = () => page.frames().find((f) => f.url().includes("app%2Findex.html"));
	const record = async (step) => {
		result.steps.push(step);
		event("step", step);
		console.log(step);
		await page.screenshot({
			path: join(out, `${String(result.steps.length).padStart(2, "0")}.png`),
		});
	};
	// Leaving the tab and coming back is how Desktop learns about file edits.
	const refocus = async () => {
		await page.evaluate(() => {
			document.hasFocus = () => false;
			dispatchEvent(new Event("blur"));
		});
		await page.evaluate(() => {
			document.hasFocus = () => true;
			dispatchEvent(new Event("focus"));
		});
	};
	const errors = () => app.getByRole("alertdialog", { name: /Error/ });

	await app
		.getByText(/Skip this step/i)
		.first()
		.click({ timeout: 300000 });
	await app.getByPlaceholder("Your Name").fill("Git Fixture");
	await app.getByPlaceholder("your-email@example.com").fill("fixture@example.org");
	await app.getByRole("button", { name: "Finish", exact: true }).click();
	await expect(app.getByRole("button", { name: /Clone a repository/i }).first()).toBeVisible();
	await expect(errors()).toHaveCount(0);
	await record("Configure Git finished; onboarding ran git lfs install without errors");

	await app
		.getByRole("button", { name: /Clone a repository/i })
		.first()
		.click();
	await app.getByText("URL", { exact: true }).click();
	await app.getByPlaceholder("URL or username/repository").fill(repoURL);
	const dest = "C:\\Users\\user\\Documents\\GitHub\\demo";
	await app.getByPlaceholder("repository path").fill(dest);
	await app.getByRole("button", { name: "Clone", exact: true }).click();
	await expect(app.getByRole("button", { name: "Current repository demo" })).toBeVisible({
		timeout: 60000,
	});
	// Desktop offers to initialize LFS for repositories that use it.
	await app.getByRole("button", { name: "Initialize Git LFS" }).click();
	const files = await renderer().evaluate((dir) => {
		const fs = require("node:fs");
		return {
			hello: fs.readFileSync(`${dir}\\hello.txt`, "utf8"),
			asset: require("node:crypto")
				.createHash("sha256")
				.update(fs.readFileSync(`${dir}\\asset.bin`))
				.digest("hex"),
		};
	}, dest);
	expect(files).toEqual({ hello: "two revisions via smart HTTP\n", asset: assetOid });
	result.clone = files;
	await expect(app.getByRole("heading", { name: "No local changes" })).toBeVisible();
	await record(
		"Cloned over smart HTTP; LFS content smudged from the batch API; working tree clean",
	);

	await renderer().evaluate((dir) => {
		const fs = require("node:fs");
		fs.writeFileSync(`${dir}\\hello.txt`, "two revisions via smart HTTP\nedited in Neutron\n");
		fs.writeFileSync(`${dir}\\notes.md`, "# Notes\n");
	}, dest);
	await refocus();
	await app.getByText("hello.txt").first().click();
	await expect(app.getByText("edited in Neutron").first()).toBeVisible();
	await record("Changes list shows the edit and the untracked file; diff view renders the patch");

	await app.getByRole("combobox", { name: "Commit summary" }).fill("Edit from Neutron");
	await app.getByRole("button", { name: /Commit 2 files to main/ }).click();
	await app.getByRole("tab", { name: "History" }).click();
	await expect(app.getByText("Edit from Neutron", { exact: true }).first()).toBeVisible();
	await expect(app.getByText("Second fixture commit", { exact: true }).first()).toBeVisible();
	await record("Committed; History lists the new commit above the fixture history");

	await app
		.getByRole("button", { name: /Push origin/ })
		.first()
		.click();
	await expect(app.getByRole("button", { name: /Fetch origin/ }).first()).toBeVisible({
		timeout: 30000,
	});
	const mainTip = await origin.resolve("demo", "refs/heads/main");
	expect(await origin.message("demo", mainTip)).toBe("Edit from Neutron\n");
	await record("Pushed main to the fixture with receive-pack");

	await app.getByRole("button", { name: /Current branch/ }).click();
	await app.getByRole("button", { name: "New branch" }).click();
	await app.getByRole("textbox", { name: "Name" }).fill("topic");
	await app.getByRole("button", { name: "Create branch" }).click();
	await expect(app.getByRole("button", { name: "Current branch topic" })).toBeVisible();
	await app
		.getByRole("button", { name: /Publish branch/ })
		.first()
		.click();
	await expect
		.poll(() => origin.resolve("demo", "refs/heads/topic"), { timeout: 30000 })
		.toBe(mainTip);
	await record("Created and published a branch");

	await app.getByRole("menuitem", { name: "Repository" }).click();
	await app.getByRole("menuitem", { name: /Repository settings/ }).click();
	const urlBox = app.locator("#repository-settings input[type=text]").first();
	await urlBox.click();
	await page.keyboard.press("Control+A");
	await page.keyboard.type(origin.url("mirror"));
	await app.getByRole("button", { name: "Save" }).click();
	await expect(app.locator("#repository-settings")).toHaveCount(0);
	await app
		.getByRole("button", { name: /Fetch origin|Publish branch|Push origin/ })
		.first()
		.click();
	await expect(app.getByRole("button", { name: /Publish branch/ }).first()).toBeVisible({
		timeout: 30000,
	});
	await app
		.getByRole("button", { name: /Publish branch/ })
		.first()
		.click();
	await expect
		.poll(() => origin.resolve("mirror", "refs/heads/topic"), { timeout: 30000 })
		.toBe(mainTip);
	expect(origin.lfsObjects.has(assetOid)).toBe(true);
	await record("Changed the remote URL in Repository settings and published to the new remote");

	expect(await errors().count()).toBe(0);
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	result.hits = origin.hits.map((h) => `${h.method} ${h.path}`);
} catch (error) {
	result.error = String(error);
	console.error(result.error);
	process.exitCode = 1;
} finally {
	if (page && !page.isClosed()) {
		await page.screenshot({ path: join(out, "final.png") }).catch(() => {});
		result.state = await page
			.locator("#runtime-state")
			.textContent()
			.catch(() => null);
		const logs = page.locator("#logs-button");
		await logs.click().catch(() => {});
		result.console = await page
			.locator("#console-output")
			.textContent()
			.catch(() => null);
	}
	await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
	await context?.close();
	await server.close();
	await origin.close();
}
