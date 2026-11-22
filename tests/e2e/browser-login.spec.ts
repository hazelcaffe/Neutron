import { expect, type Frame, type JSHandle, type Locator } from "@playwright/test";
import { test } from "./package-profile";

const cases = [
	{
		name: "Figma",
		resources: process.env.NEUTRON_FIGMA_RESOURCES,
		domain: "figma.com",
		button: /^log in with browser$/i,
		manifest: /figma.*126\.12\.7/i,
	},
	{
		name: "GitHub Desktop",
		resources: process.env.NEUTRON_GITHUB_DESKTOP_RESOURCES,
		domain: "github.com",
		button: /^sign in to GitHub\.com$/i,
		manifest: /desktop.*3\.6\.11/i,
	},
];

// Inspect the committed document, not the iframe's requested src (which can
// point at a grant even if the frame is blank). Never print either URL.
function isProxied(frame: Frame, host: string, domain: string): boolean {
	try {
		const url = new URL(frame.url());
		const match = /^\/__scramjet__\/[^/]+\/(.+)$/.exec(url.pathname);
		if (url.origin !== host || !match?.[1]) return false;
		const target = new URL(decodeURIComponent(match[1]));
		return (
			target.protocol === "https:" &&
			(target.hostname === domain || target.hostname.endsWith(`.${domain}`))
		);
	} catch {
		return false;
	}
}

async function inNewVisibleWindow(frame: Frame, prior: JSHandle<Set<Element>>) {
	const iframe = await frame.frameElement();
	try {
		return (
			(await iframe.isVisible()) &&
			(await iframe.evaluate((el, before) => {
				const owner =
					el instanceof HTMLIFrameElement &&
					el.closest(".runtime-window:not(.runtime-view), dialog");
				return !!owner && !before.has(owner);
			}, prior))
		);
	} finally {
		await iframe.dispose();
	}
}

// A blank frame, proxy error, or the old desktop button is not the vendor
// login form. Observe sign-in controls; don't interact with them.
function signInControl(frame: Frame) {
	return frame
		.locator('input[type="email"], input[autocomplete="username"], input[name="login"]')
		.or(frame.getByRole("button", { name: /(?:continue|sign in|log in) with (?:google|sso)/i }))
		.filter({ visible: true })
		.first();
}

for (const target of cases)
	test.describe(target.name, () => {
		test.skip(
			!target.resources,
			"Provide official package resources and use tests/browser-login.playwright.config.ts",
		);
		test(`official ${target.name} opens browser login in a new proxied runtime window`, async ({
			context,
			baseURL,
		}) => {
			const host = "http://127.0.0.1:4251";
			expect(baseURL, "Use the private browser-login Playwright config").toBe(host);
			const page = context.pages()[0] || (await context.newPage());
			expect(context.pages().length).toBe(1);
			let extraPages = 0;
			// A noopener window or a page that closes itself can escape page.on('popup')
			// and a final context.pages() count. Keep this listener active from launch.
			context.on("page", () => extraPages++);
			await page.goto("/");
			await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
			await page.locator("#settings-button").click();
			await page.locator("#compat-platform").selectOption("win32");
			await page.getByRole("button", { name: "Save settings", exact: true }).click();
			await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
			await page.locator("#folder-input").setInputFiles(target.resources as string);
			await expect(page.locator("#application-select option:checked")).toHaveText(
				target.manifest,
				{
					timeout: 60_000,
				},
			);

			let button: Locator | undefined;
			await expect
				.poll(
					async () => {
						for (const frame of page.mainFrame().childFrames()) {
							const candidate = frame
								.getByRole("button", { name: target.button })
								.or(frame.getByRole("link", { name: target.button }))
								.filter({ visible: true })
								.first();
							if (await candidate.isVisible()) {
								button = candidate;
								return true;
							}
						}
						return false;
					},
					{ message: `${target.name}'s browser login button`, timeout: 90_000 },
				)
				.toBe(true);

			if (!button) throw new Error("Desktop login button missing");
			expect(extraPages, "An extra Chromium page opened before clicking login").toBe(0);
			const originalWindows = await page.evaluateHandle(
				() =>
					new Set(
						document.querySelectorAll(".runtime-window:not(.runtime-view), dialog"),
					),
			);
			let directGrantNavigation = false;
			// Passive evidence even if the new page redirects before its first commit.
			// Keep only the classification, never the grant identifier or query.
			context.on("request", (request) => {
				const u = URL.parse(request.url());
				if (
					request.isNavigationRequest() &&
					u?.protocol === "https:" &&
					(u.hostname === target.domain || u.hostname.endsWith(`.${target.domain}`))
				)
					directGrantNavigation = true;
			});
			let proxiedLoginWindow = false;
			let vendorUI = false;
			try {
				await button.click({ timeout: 10_000 });
				await expect
					.poll(
						async () => {
							for (const frame of page.mainFrame().childFrames()) {
								if (!isProxied(frame, host, target.domain)) continue;
								if (!(await inNewVisibleWindow(frame, originalWindows))) continue;
								proxiedLoginWindow = true;
								vendorUI = await signInControl(frame).isVisible();
								if (vendorUI) break;
							}
							return extraPages > 0 || vendorUI;
						},
						{
							message: `${target.name} login should reach the vendor's visible sign-in controls`,
							timeout: 60_000,
						},
					)
					.toBe(true);
				await expect(page.locator("#runtime-state")).toHaveText("Application running");
				expect(extraPages, "Browser login escaped into a separate Chromium page").toBe(0);
				expect(directGrantNavigation, "Browser login navigated directly to the grant").toBe(
					false,
				);
				expect(proxiedLoginWindow && vendorUI).toBe(true);
			} finally {
				console.log(`${target.name} login probe:`, {
					extraPages,
					directGrantNavigation,
					proxiedLoginWindow,
					vendorUI,
				});
				await originalWindows.dispose();
			}
		});
	});
