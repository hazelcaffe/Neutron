import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { catalog } from "./catalog.mjs";

const cache = resolve(process.env.NEUTRON_APP_CACHE || ".cache/compat-apps");
const { positionals: requested, values } = parseArgs({
	allowPositionals: true,
	options: {
		port: { type: "string", default: "4190" },
		fresh: { type: "boolean" },
		trace: { type: "boolean" },
	},
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535)
	throw new Error("--port must be an integer from 1 to 65535");
const startTimeout = Number(process.env.NEUTRON_START_TIMEOUT || 90_000);
if (!Number.isFinite(startTimeout) || startTimeout < 0)
	throw new Error("NEUTRON_START_TIMEOUT must be a non-negative number of milliseconds");
// Port is part of the OPFS origin. Give each origin a profile namespace and
// a latest-results pointer of its own; vendor inputs are shared read-only.
const lane = port === 4190 ? cache : join(cache, "lanes", String(port));
const selected = requested.length ? catalog.filter((app) => requested.includes(app.id)) : catalog;
if (requested.some((id) => !catalog.some((app) => app.id === id)))
	throw new Error("Unknown app ID. See scripts/compat/catalog.mjs.");
const tag = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(lane, "results", tag);
const server = await preview({
	root: process.cwd(),
	preview: { host: "127.0.0.1", port, strictPort: true },
});
const base = `http://127.0.0.1:${port}`;
const results = [];

async function inspect(page) {
	return page.evaluate(() => ({
		state: document.querySelector("#runtime-state")?.textContent,
		events: window.__neutronSweep?.slice(-1200) || [],
		windows: [...document.querySelectorAll(".runtime-window")]
			.filter((item) => !item.classList.contains("runtime-view"))
			.map((item) => ({
				visible: !item.hidden,
				title: item.getAttribute("aria-label"),
				url: item.querySelector("iframe")?.src,
				tab: document
					.querySelector(
						`.window-tab[data-window-id="${item.querySelector("iframe")?.dataset.neutronId}"] [role="tab"]`,
					)
					?.getAttribute("title"),
			})),
	}));
}
async function collectLogs(page) {
	return page
		.evaluate(async () => {
			const files = [];
			const root = await navigator.storage.getDirectory();
			const apps = await (await root.getDirectoryHandle("neutron")).getDirectoryHandle(
				"apps",
			);
			async function walk(dir, path, depth = 0) {
				if (depth > 12 || files.length >= 20) return;
				for await (const [name, handle] of dir.entries()) {
					if (handle.kind === "directory")
						await walk(handle, `${path}/${name}`, depth + 1);
					else if (/\.log(?:\.\d+)?$|^logs?\.txt$/i.test(name)) {
						const file = await handle.getFile();
						files.push({
							path: `${path}/${name}`,
							tail: await file.slice(Math.max(0, file.size - 16000)).text(),
						});
					}
				}
			}
			for await (const [, app] of apps.entries())
				if (app.kind === "directory") {
					const fs = await app.getDirectoryHandle("fs");
					for (const name of ["home", "tmp"])
						try {
							await walk(await fs.getDirectoryHandle(name), `/${name}`);
						} catch {}
				}
			return files;
		})
		.catch(() => []);
}

// On a reused origin `serviceWorker.ready` can resolve with yesterday's active
// worker while the browser schedules an update check. Launch this preview's
// host and worker together: an old worker may not understand its storage RPCs.
async function waitForPreviewWorker(page) {
	const start = performance.now();
	const check = await page.evaluateHandle(async () => {
		const previous = navigator.serviceWorker.controller;
		const registration = await navigator.serviceWorker.ready;
		await registration.update();
		const worker = registration.installing || registration.waiting || registration.active;
		if (!worker) throw new Error("Preview has no service worker after update check");
		return { worker, changed: worker !== previous };
	});
	try {
		const handle = await page.waitForFunction(
			({ worker, changed }) => {
				if (worker.state === "redundant") throw new Error("Preview worker update failed");
				return (
					worker.state === "activated" &&
					navigator.serviceWorker.controller === worker && {
						changed,
						url: worker.scriptURL,
					}
				);
			},
			check,
			{ timeout: 30_000 },
		);
		return { ...(await handle.jsonValue()), elapsedMs: Math.round(performance.now() - start) };
	} finally {
		await check.dispose();
	}
}

function recordEvents() {
	const events = [];
	window.__neutronSweep = events;
	const record = (data) => {
		events.push({ ...data, time: Date.now() });
		if (events.length > 1500) events.shift();
	};
	if (window === window.top)
		navigator.serviceWorker.addEventListener("controllerchange", () =>
			record({ type: "controller-change", state: navigator.serviceWorker.controller?.state }),
		);
	const WorkerClass = window.Worker;
	window.Worker = class extends WorkerClass {
		postMessage(data, ...args) {
			if (
				(data?.type === "window-event" &&
					["dom-ready", "did-finish-load", "did-fail-load"].includes(data.event)) ||
				(window.__neutronTrace && ["window-event", "ipc", "sync-ipc"].includes(data?.type))
			)
				record({
					type: "trace-to-main",
					event: data.event,
					channel: data.channel,
					windowId: data.windowId,
					...(data.channel === "SLACK_PRELOAD_ERROR"
						? {
								args: data.args?.map((value) => ({
									message: value?.message,
									stack: value?.stack,
									...value,
								})),
							}
						: {}),
				});
			if (data?.type === "result" && data.error)
				record({ type: "rpc-error", id: data.id, message: data.error });
			return super.postMessage(data, ...args);
		}
		constructor(...args) {
			super(...args);
			if (window.__neutronTrace) {
				const source = String(args[0]);
				const url = source.startsWith("data:") ? "data:" : source.slice(0, 1024);
				record({ type: "worker-created", url, mode: args[1]?.type || "classic" });
				this.addEventListener("error", (event) =>
					record({
						type: "worker-error",
						url,
						filename: event.filename?.slice(0, 1024),
						line: event.lineno,
						column: event.colno,
						message: event.message,
					}),
				);
			}
			this.addEventListener("message", ({ data }) => {
				if (["log", "fatal", "error", "started", "quit", "progress"].includes(data?.type))
					record(data);
				else if (data?.type === "rpc" && data.method === "window.load")
					record({
						type: "navigation",
						id: data.id,
						windowId: data.args[0],
						url: data.args[1],
					});
				else if (
					window.__neutronTrace &&
					["window-create", "window-command", "renderer-event", "ipc-result"].includes(
						data?.type,
					)
				)
					record({
						type: "trace-from-main",
						method: data.method,
						channel: data.channel,
						windowId: data.windowId,
					});
			});
		}
	};
	let bridge;
	Object.defineProperty(window, "__neutron", {
		configurable: true,
		get: () => bridge,
		set: (value) => {
			bridge = {
				...value,
				send(id, message) {
					if (message?.type === "log") record(message);
					return value.send(id, message);
				},
			};
		},
	});
}
// Runs in the host page. A visible BrowserWindow can still contain the initial,
// empty about:blank for its entire lifetime. An attached WebContentsView may
// instead be the renderer that commits. Neither signal is a UI verification.
function rendererReadiness() {
	const state = document.querySelector("#runtime-state")?.textContent;
	if (state === "Application error") return { outcome: "application-error" };
	const events = window.__neutronSweep || [];
	if (state === "Runtime ready" && events.some((event) => event.type === "quit"))
		return { outcome: "exited" };
	for (const frame of document.querySelectorAll(
		".runtime-window:not(.runtime-view):not([hidden]) iframe[data-neutron-id]",
	)) {
		if (!frame.checkVisibility()) continue;
		const doc = frame.contentDocument;
		const windowId = Number(frame.dataset.neutronId);
		if (doc) {
			if (doc.readyState === "loading") continue;
			// biome-ignore lint/performance/useDomNodeTextContent: A script or hidden text alone isn't a rendered blank-document UI.
			if (doc.URL === "about:blank" && !doc.body?.innerText.trim()) continue;
			return { outcome: "document-ready", windowId, url: doc.URL };
		}
		// Opaque documents (e.g. data: URLs) cannot be inspected from the host.
		if (
			events.some(
				(event) =>
					event.windowId === windowId &&
					(event.event === "dom-ready" || event.event === "did-finish-load"),
			)
		)
			return { outcome: "document-ready", windowId, url: frame.src };
	}
	return false;
}

// isVisible() inside a child frame does not establish that its embedding
// iframe, or the containing app window, is actually being shown.
async function inVisibleRenderer(frame) {
	for (let parent = frame.parentFrame(); parent; parent = frame.parentFrame()) {
		const element = await frame.frameElement();
		try {
			if (!(await element.isVisible())) return false;
			if (!parent.parentFrame())
				return await element.evaluate((item) =>
					Boolean(item.closest(".runtime-window:not(.runtime-view):not([hidden])")),
				);
		} finally {
			await element.dispose();
		}
		frame = parent;
	}
	return false;
}

async function probe(page, id, startupDeadline = 0) {
	const visible = page.locator(".runtime-window:not([hidden]) > iframe").first();
	if (!(await visible.count())) return [];
	let frame = visible.contentFrame();
	const checks = [];
	const markers = {
		drawio: /Create New Diagram|Create new diagram|Untitled Diagram|New Diagram|Select a Device/i,
		joplin: /Welcome to Joplin|New note|Notebooks|All notes/i,
		bitwarden: /Log in|Email address|Master password|Create account/i,
		insomnia: /Create a project|Local Vault|Scratch Pad|Welcome to Insomnia|Log in|Sign up/i,
		vesktop: /Welcome back|Log In|Email or Phone|Vesktop|Select.*Vencord/i,
		discord: /Welcome back|Log In|Log in|Email or phone/i,
		signal: /Link.*phone|Scan.*QR|Welcome to Signal|Set up Signal/i,
		slack: /Sign in to Slack|Sign in|Get started|Find your workspace/i,
		notion: /Log in|Continue with|Welcome to Notion/i,
		figma: /Log in|Sign in|Get started/i,
		"github-desktop": /Welcome to GitHub Desktop|Sign in to GitHub|Configure Git/i,
		"1password": /Welcome to 1Password|Sign in|Add.*account|Get started/i,
		tidal: /Log in|Sign up|Welcome|Start free trial/i,
		vscode: /Visual Studio Code|Get Started|Welcome|New File|Restricted Mode|Open in Agents/i,
		obsidian: /Create new vault|Open folder as vault/i,
		postman: /Continue without an account|Lightweight API Client|Scratch Pad|Create a request/i,
	};
	if (markers[id]) {
		let match;
		// The first ready document may be a splash or one of several views.
		// Give the actual marker the rest of the launch budget as well.
		const deadline = Math.max(
			startupDeadline,
			performance.now() + (id === "vscode" ? 45_000 : 15_000),
		);
		while (!match && performance.now() < deadline) {
			for (const candidate of page.frames().slice(1)) {
				try {
					const marker = candidate
						.getByText(markers[id])
						.filter({ visible: true })
						.first();
					if ((await marker.isVisible()) && (await inVisibleRenderer(candidate))) {
						// biome-ignore lint/performance/useDomNodeTextContent: Capture the visible label that satisfied the probe.
						const text = await marker.innerText({ timeout: 500 });
						if (!markers[id].test(text.replace(/\s+/g, " "))) continue;
						match = { text: text.slice(0, 300), url: candidate.url() };
						frame = candidate;
						break;
					}
				} catch {}
			}
			if (!match) {
				const state = await page.evaluate(
					() => document.querySelector("#runtime-state")?.textContent,
				);
				if (state === "Application error" || state === "Runtime ready") break;
				await page.waitForTimeout(200);
			}
		}
		checks.push({ name: "expected initial UI", passed: Boolean(match), ...match });
	}
	if (id === "vesktop") {
		const submit = frame.getByRole("button", { name: "Submit", exact: true });
		if (await submit.isVisible().catch(() => false)) {
			await submit.click();
			const active = page
				.locator(".runtime-window:not([hidden]) > iframe")
				.first()
				.contentFrame();
			const passed = await active
				.getByText(/Welcome back|Email or Phone Number/)
				.first()
				.waitFor({ state: "visible", timeout: 30_000 })
				.then(
					() => true,
					() => false,
				);
			checks.push({ name: "Discord login after setup", passed });
		}
	}
	if (id === "vscode") {
		const skip = frame.getByText("Continue without Signing In", { exact: true });
		if (await skip.isVisible().catch(() => false)) await skip.click();
		try {
			await frame.locator(".monaco-workbench").press("Control+n");
			await frame
				.getByText(/Untitled-\d+/, { exact: true })
				.filter({ visible: true })
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
			await page.keyboard.insertText("Neutron compatibility check");
			const passed = await frame
				.locator(".view-lines")
				.filter({ hasText: "Neutron compatibility check" })
				.first()
				.waitFor({ state: "visible", timeout: 5000 })
				.then(
					() => true,
					() => false,
				);
			checks.push({ name: "create untitled file and type text", passed });
		} catch {
			checks.push({ name: "create untitled file and type text", passed: false });
		}
	}
	if (id === "joplin" && checks.some((check) => check.passed)) {
		try {
			const welcome = frame
				.getByText("Welcome!", { exact: true })
				.filter({ visible: true })
				.first();
			if (await welcome.isVisible()) await welcome.click();
			const create = frame.locator(".new-note-button").filter({ visible: true }).first();
			if (await create.isVisible()) await create.click();
			else await frame.locator("body").press("Control+n");
			const input = frame
				.locator(".note-title-wrapper input.title-input")
				.filter({ visible: true })
				.first();
			const title = `Neutron check ${Date.now()}`;
			await input.fill(title, { timeout: 12000 });
			await input.press("Tab");
			await frame
				.getByText(title, { exact: true })
				.filter({ visible: true })
				.first()
				.waitFor({ timeout: 12000 });
			checks.push({ name: "create and title a note in the notebook list", passed: true });
		} catch (error) {
			checks.push({
				name: "create and title a note in the notebook list",
				passed: false,
				detail: String(error).split("\n")[0],
			});
		}
	}
	if (
		id === "tidal" &&
		(await frame
			.getByText("Page not found", { exact: true })
			.isVisible()
			.catch(() => false))
	) {
		checks.push({ name: "remote route error page", passed: false });
		for (const check of checks) if (check.name === "expected initial UI") check.passed = false;
	}
	if (id === "github-desktop") {
		const skip = frame.getByText(/Skip this step/i).first();
		if (await skip.isVisible().catch(() => false)) {
			await skip.click();
			const passed = await frame
				.getByText("Configure Git", { exact: true })
				.waitFor({ state: "visible" })
				.then(
					() => true,
					() => false,
				);
			checks.push({ name: "welcome step navigation", passed });
		}
	}
	if (id === "postman") {
		const without = frame.getByText("Continue without an account", { exact: true });
		if (await without.isVisible().catch(() => false)) await without.click();
		// The welcome action can replace the BrowserWindow, so resolve the active
		// frame again instead of retaining the old frame object.
		const active = page
			.locator(".runtime-window:not([hidden]) > iframe")
			.first()
			.contentFrame();
		const light = active.getByText("Open Lightweight API Client", { exact: true });
		await light.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
		if (await light.isVisible()) await light.click();
		const ready = active.getByText(/^(Send|Create a request)$/).first();
		const passed = await ready.waitFor({ state: "visible", timeout: 30_000 }).then(
			() => true,
			() => false,
		);
		checks.push({ name: "account-free request client visible", passed });
	}
	return checks;
}

try {
	await mkdir(output, { recursive: true });
	console.log(`Preview: ${base} · Results: ${output}`);
	for (const app of selected) {
		let manifest;
		try {
			manifest = JSON.parse(await readFile(join(cache, app.id, "manifest.json"), "utf8"));
		} catch {
			results.push({ id: app.id, name: app.name, status: "not-downloaded" });
			continue;
		}
		const result = {
			id: app.id,
			name: app.name,
			version: manifest.package?.version || manifest.version,
			sha256: manifest.sha256,
			source: app.source,
			checkedAt: new Date().toISOString(),
		};
		if (manifest.status !== "ready") {
			results.push({
				...result,
				status: manifest.status,
				reason: manifest.reason || manifest.error,
			});
			continue;
		}
		console.log(`${app.id}: importing/launching ${result.version || ""}`);
		const profileRoot = join(lane, app.id);
		await mkdir(profileRoot, { recursive: true });
		const profile = join(profileRoot, "browser-profile");
		const marker = join(profileRoot, "profile-source.json");
		let previous;
		try {
			previous = JSON.parse(await readFile(marker, "utf8"));
		} catch {}
		const fingerprint = manifest.resourceFingerprint || manifest.sha256;
		if (values.fresh || previous?.sha256 !== fingerprint)
			await rm(profile, { recursive: true, force: true });
		const context = await chromium.launchPersistentContext(profile, {
			headless: true,
			viewport: { width: 1440, height: 1000 },
			args: ["--disable-dev-shm-usage"],
		});
		const page = context.pages()[0] || (await context.newPage());
		page.setDefaultTimeout(8000);
		const browserErrors = [];
		const browserConsole = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) {
				browserConsole.push(message.text().slice(0, 3000));
				if (browserConsole.length > 100) browserConsole.shift();
			}
		});
		const failedRequests = [];
		const fileImages = [];
		if (values.trace)
			page.on("response", (response) => {
				const url = response.url();
				if (response.request().resourceType() !== "image" || !url.includes("/file%3A"))
					return;
				fileImages.push({
					url: url.slice(0, 1024),
					status: response.status(),
					type: response.headers()["content-type"],
				});
				if (fileImages.length > 100) fileImages.shift();
			});
		page.on("pageerror", (error) =>
			browserErrors.push(
				values.trace ? (error.stack || error.message).slice(0, 3000) : error.message,
			),
		);
		page.on("requestfailed", (request) => {
			if (failedRequests.length < 30)
				failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
		});
		let state;
		try {
			if (values.trace)
				await page.addInitScript(() => {
					window.__neutronTrace = true;
				});
			await page.addInitScript(recordEvents);
			await page.goto(base);
			await page
				.locator("#runtime-state")
				.filter({ hasText: "Runtime ready" })
				.waitFor({ timeout: 30_000 });
			result.workerReadiness = await waitForPreviewWorker(page);
			const installed = await page.locator("#application-select").inputValue();
			const platform = app.format === "exe" ? "win32" : "linux";
			result.platform = platform;
			await page.locator("#settings-button").click();
			await page.locator("#compat-platform").selectOption(platform);
			await page.getByRole("button", { name: "Save settings", exact: true }).click();
			await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "hidden" });
			result.freshImport = !installed;
			if (installed) await page.locator("#launch-button").click();
			else {
				await page.locator("#folder-input").setInputFiles(manifest.resources);
				await page.locator("#import-progress").waitFor({
					state: "hidden",
					timeout: Number(process.env.NEUTRON_IMPORT_TIMEOUT || 600_000),
				});
				await writeFile(marker, JSON.stringify({ sha256: fingerprint }));
			}
			const imported = await page.locator("#application-select").inputValue();
			if (!imported) {
				result.status = "import-failed";
			} else {
				const observing = performance.now();
				const readiness = await page
					.waitForFunction(rendererReadiness, undefined, {
						timeout: startTimeout,
						polling: 200,
					})
					.then((handle) => handle.jsonValue())
					.catch((error) => {
						if (error.name !== "TimeoutError") throw error;
						return { outcome: "timeout" };
					});
				result.readiness = {
					...readiness,
					elapsedMs: Math.round(performance.now() - observing),
					timeoutMs: startTimeout,
				};
				if (process.env.NEUTRON_SWEEP_WAIT)
					await page.waitForTimeout(Number(process.env.NEUTRON_SWEEP_WAIT));
				state = await inspect(page);
				if (state.state === "Application error") result.status = "runtime-error";
				else if (state.state === "Runtime ready") result.status = "exited";
				else if (state.windows.some((window) => window.visible)) {
					const checks = await probe(page, app.id, observing + startTimeout);
					result.checks = checks;
					result.status = checks.some(
						(check) => check.name === "expected initial UI" && check.passed,
					)
						? "initial-ui-verified"
						: "renderer-unverified";
				} else {
					result.status = "no-visible-renderer";
					const reveal = page
						.locator('.window-tab[data-state="hidden"] [role="tab"]')
						.first();
					if (await reveal.count()) {
						result.beforeWindowReveal = state.windows;
						await reveal.click();
						const checks = await probe(page, app.id);
						result.checks = checks;
						result.manualWindowReveal = true;
						if (
							checks.some(
								(check) => check.name === "expected initial UI" && check.passed,
							)
						)
							result.status = "ui-verified-after-window-reveal";
					}
				}
				result.observedMs = Math.round(performance.now() - observing);
			}
			state = await inspect(page);
			// A briefly visible screen is not a successful launch if the main
			// process failed or exited while the checks were running.
			if (state.state === "Application error") result.status = "runtime-error";
			else if (state.state === "Runtime ready" && imported) result.status = "exited";
			const frames = [];
			const diagnostics = [];
			for (const frame of page.frames().slice(1)) {
				try {
					if (app.id === "vscode")
						diagnostics.push(
							await frame.evaluate(async () => {
								const config = await Reflect.get(
									window,
									"vscode",
								)?.context?.resolveConfiguration?.();
								return { profiles: config?.profiles };
							}),
						);
					diagnostics.push(
						await frame.evaluate(() => ({
							url: location.href,
							workers: window.__neutronSweep
								?.filter(
									(event) =>
										event.type === "worker-created" ||
										event.type === "worker-error",
								)
								.slice(-30),
							ready: document.readyState,
							elements: document.querySelectorAll("*").length,
							marks: performance.getEntriesByType("mark").map((mark) => mark.name),
							scripts: [...document.scripts]
								.map((script) => script.src)
								.filter(Boolean),
						})),
					);
					frames.push({
						url: frame.url(),
						text: await frame.locator("body").evaluate(
							(body) => {
								// biome-ignore lint/performance/useDomNodeTextContent: Evidence should be rendered UI text, not script/style source.
								return body.innerText.slice(0, 6000);
							},
							undefined,
							{
								timeout: 3000,
							},
						),
					});
				} catch {
					frames.push({ url: frame.url(), text: "unavailable" });
				}
			}
			const artifact = join(output, app.id);
			await mkdir(artifact, { recursive: true });
			await page
				.screenshot({ path: join(artifact, "screen.png"), fullPage: true, timeout: 5000 })
				.catch(() => {});
			const files = await collectLogs(page);
			await writeFile(
				join(artifact, "details.json"),
				JSON.stringify(
					{
						manifest,
						workerReadiness: result.workerReadiness,
						readiness: result.readiness,
						observedMs: result.observedMs,
						beforeWindowReveal: result.beforeWindowReveal,
						checks: result.checks,
						state,
						frames,
						diagnostics,
						...(values.trace ? { fileImages } : {}),
						browserConsole,
						browserErrors,
						failedRequests,
						files,
					},
					null,
					2,
				),
			);
			result.artifacts = artifact;
			result.frames = frames.map((frame) => ({
				url: frame.url,
				excerpt: frame.text.slice(0, 300),
			}));
			result.firstError =
				state.events.find(
					(event) =>
						event.type === "fatal" || event.type === "error" || event.level === "error",
				)?.message || browserErrors[0];
			result.stubCalls = [
				...new Set(
					state.events
						.filter((event) => event.message?.startsWith("[compat]"))
						.map((event) => event.message.split(": using a fallback")[0]),
				),
			].slice(0, 30);
		} catch (error) {
			result.status = "harness-error";
			result.error = String(error);
			const artifact = join(output, app.id);
			await mkdir(artifact, { recursive: true });
			result.artifacts = artifact;
			await writeFile(
				join(artifact, "details.json"),
				JSON.stringify(
					{
						manifest,
						state: await inspect(page).catch(() => null),
						progress: await page
							.locator("#busy-text")
							.textContent()
							.catch(() => null),
						browserErrors,
						browserConsole,
						failedRequests,
					},
					null,
					2,
				),
			);
		} finally {
			if (!page.isClosed()) {
				await page
					.locator("dialog[open]")
					.evaluateAll((dialogs) => {
						for (const dialog of dialogs) dialog.close();
					})
					.catch(() => {});
				if (
					await page
						.locator("#stop-button")
						.isEnabled()
						.catch(() => false)
				) {
					await page
						.locator("#stop-button")
						.click({ timeout: 3000 })
						.catch(() => {});
					await page
						.waitForFunction(
							() =>
								document.querySelector("#runtime-state")?.textContent ===
								"Runtime ready",
							undefined,
							{ timeout: 5000 },
						)
						.catch(() => {});
				}
			}
			await context.close();
		}
		results.push(result);
		console.log(
			`${app.id}: ${result.status}${result.firstError ? ` — ${result.firstError.split("\n")[0]}` : ""}`,
		);
		await writeFile(join(output, "summary.json"), JSON.stringify(results, null, 2));
		await writeFile(
			join(lane, "latest-results.json"),
			JSON.stringify({ run: output, results }, null, 2),
		);
	}
} finally {
	await new Promise((resolve) => server.httpServer.close(resolve));
}
await writeFile(join(output, "summary.json"), JSON.stringify(results, null, 2));
await writeFile(
	join(lane, "latest-results.json"),
	JSON.stringify({ run: output, results }, null, 2),
);
console.log(`Results: ${output}`);
