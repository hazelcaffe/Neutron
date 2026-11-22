// Run against a private snapshot of dist, with a new profile for every run.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import {
	contents,
	head,
	repoURL,
	startFixture,
} from "../../packages/runtime/tests/git-smart-fixture.ts";

const cache = resolve(".cache/compat-apps");
const manifest = JSON.parse(await readFile(join(cache, "github-desktop/manifest.json")));
const root = join(cache, "git-ui");
await mkdir(root, { recursive: true });
const out = await mkdtemp(join(root, "desktop-"));
const build = resolve(process.env.NEUTRON_GIT_BUILD || "dist");
await cp(build, join(out, "dist"), { recursive: true });
console.log(out);
const result = {
	build,
	package: manifest.package,
	sha256: manifest.sha256,
	hits: [],
	steps: [],
	events: [],
};
const event = (kind, data) => result.events.push({ time: Date.now(), kind, data });
const fixture = await startFixture(result.hits);
const server = await preview({
	build: { outDir: join(out, "dist") },
	preview: { host: "127.0.0.1", port: 4260, strictPort: true },
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
	page.on("framenavigated", (f) =>
		event(f === page.mainFrame() ? "shell-navigation" : "frame-navigation", f.url()),
	);
	page.on("pageerror", (e) => event("pageerror", e.stack));
	page.on("console", (m) => {
		if (["error", "warning"].includes(m.type())) event(m.type(), m.text().slice(0, 2000));
	});
	await page.exposeFunction("recordGitTestEvent", event);
	await page.addInitScript(() => {
		if (window !== window.top) return;
		navigator.serviceWorker.addEventListener("controllerchange", () =>
			window.recordGitTestEvent(
				"sw-controller",
				navigator.serviceWorker.controller?.scriptURL,
			),
		);
		window.Worker = class extends Worker {
			constructor(...args) {
				super(...args);
				const url = String(args[0]);
				this.testSource = url;
				window.recordGitTestEvent("worker-created", url);
				this.addEventListener("message", ({ data }) => {
					if (["quit", "started", "fatal", "error", "log"].includes(data?.type))
						window.recordGitTestEvent("worker-message", data);
				});
				this.addEventListener("error", (e) =>
					window.recordGitTestEvent("worker-error", e.message),
				);
			}
			terminate() {
				window.recordGitTestEvent("worker-terminate", this.testSource);
				super.terminate();
			}
		};
	});
	await page.goto("http://127.0.0.1:4260/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 30000 });
	await page.locator("#settings-button").click();
	await page.locator("#compat-platform").selectOption("win32");
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4260/wisp/");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await page.locator("#folder-input").setInputFiles(manifest.resources);
	const app = page
		.locator(".runtime-window:not(.runtime-view):visible > iframe")
		.first()
		.contentFrame();
	const record = async (step) => {
		result.steps.push(step);
		event("step", step);
		console.log(step);
		await page.screenshot({ path: join(out, `${result.steps.length}.png`) });
	};
	await app
		.getByText(/Skip this step/i)
		.first()
		.click({ timeout: 300000 });
	await app.getByPlaceholder("Your Name").fill("Git Fixture");
	await app.getByPlaceholder("your-email@example.com").fill("fixture@example.org");
	await app.getByRole("button", { name: "Finish", exact: true }).click();
	await record("Finished account-free Configure Git");
	// Onboarding offers LFS installation. This adapter has no LFS executable;
	// dismiss that specific reported error like a user with plain Git would.
	const lfs = app
		.getByRole("alertdialog", { name: "Error" })
		.filter({ hasText: /unsupported git command: lfs/ });
	if (
		await lfs.waitFor({ timeout: 5000 }).then(
			() => true,
			() => false,
		)
	) {
		await record("LFS installation reported unsupported");
		await lfs.getByRole("button", { name: "Close", exact: true }).last().click();
	}
	await app
		.getByRole("button", { name: /Clone a repository/i })
		.first()
		.click();
	await app.getByText("URL", { exact: true }).click();
	await app.getByPlaceholder("URL or username/repository").fill(repoURL);
	const dest = "/home/user/git-tests/two";
	await app.getByPlaceholder("repository path").fill(dest);
	await record("URL clone dialog filled");
	await app.getByRole("button", { name: "Clone", exact: true }).click();
	await record("Clicked Clone");
	const appId = await page.locator("#application-select").inputValue();
	const readRepo = () =>
		page.evaluate(
			async ({ appId, dest }) => {
				let dir = await navigator.storage.getDirectory();
				for (const part of [
					"neutron",
					"apps",
					appId,
					"fs",
					...dest.split("/").filter(Boolean),
				])
					dir = await dir.getDirectoryHandle(part);
				const read = async (path) => {
					let d = dir;
					const parts = path.split("/");
					const name = parts.pop();
					for (const p of parts) d = await d.getDirectoryHandle(p);
					return (await (await d.getFileHandle(name)).getFile()).text();
				};
				return {
					contents: await read("hello.txt"),
					head: (await read(".git/refs/heads/main")).trim(),
					ref: await read(".git/HEAD"),
				};
			},
			{ appId, dest },
		);
	await expect
		.poll(() => readRepo().catch(() => null), { timeout: 30000 })
		.toMatchObject({ contents, head });
	result.clone = await readRepo();
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	await record("Verified checked-out fixture contents and HEAD in OPFS");
	await expect(app.getByRole("button", { name: "Current repository two" })).toBeVisible();
	await expect(app.getByRole("heading", { name: "No local changes" })).toBeVisible();
	await app.getByRole("tab", { name: "History" }).click();
	for (const subject of ["Second fixture commit", "Initial fixture"])
		await expect(app.getByText(subject, { exact: true }).first()).toBeVisible({
			timeout: 12000,
		});
	await record("Desktop History shows both fixture commits");
	await expect(app.getByRole("button", { name: "Current branch main" })).toBeVisible();
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	expect(result.hits.map((h) => h.method)).toEqual(["GET", "POST"]);
	expect(result.events.filter((e) => e.kind === "shell-navigation")).toHaveLength(1);
	expect(
		result.events.filter(
			(e) =>
				(e.kind === "worker-terminate" && e.data === "/runtime/main-worker.js") ||
				(e.kind === "worker-message" && ["quit", "fatal"].includes(e.data?.type)),
		),
	).toHaveLength(0);
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
		result.frames = await Promise.all(
			page
				.frames()
				.slice(1)
				.map(async (f) => ({
					url: f.url(),
					ui: await f
						.locator("body")
						.ariaSnapshot({ timeout: 3000 })
						.catch(() => null),
				})),
		);
		result.console = await page
			.locator("#console-output")
			.textContent()
			.catch(() => null);
	}
	await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
	await context?.close();
	await server.close();
	await new Promise((ok) => fixture.close(ok));
}
