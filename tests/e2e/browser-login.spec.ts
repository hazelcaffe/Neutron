import { expect, type Frame, type JSHandle, type Locator, type Page } from "@playwright/test";
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

// Run code as a page <script>, so Scramjet rewrites it like the vendor's own code.
function pageScript(frame: Frame, code: string): Promise<void> {
	return frame.evaluate((source) => {
		const script = document.createElement("script");
		script.textContent = source;
		document.body.append(script);
	}, code);
}
const proxiedPath = (path: string) =>
	new RegExp(`/__scramjet__/[^/]+/https%3A%2F%2Fwww\\.figma\\.com${encodeURIComponent(path)}`);

// Every step after Figma's sign-in form appears, without an account. Each one
// must reach Figma's own response through Scramjet, not a proxy failure.
async function figmaSignInSteps(page: Page, frame: Frame): Promise<void> {
	const tabs = page.locator("iframe[data-neutron-browser]");
	// Password form: Figma's credentials error proves the POST, cookies and CSRF.
	await frame
		.locator('input[type="email"]')
		.filter({ visible: true })
		.first()
		.fill("neutron-probe-nobody@example.invalid");
	await frame
		.locator('input[type="password"]')
		.filter({ visible: true })
		.first()
		.fill("not-a-real-password");
	const login = page.waitForResponse(
		(r) => r.request().method() === "POST" && proxiedPath("/api/session/login").test(r.url()),
	);
	await frame.getByRole("button", { name: /^log in$/i }).click();
	expect((await login).status()).toBe(401);
	await expect(frame.getByText(/email and password combination is incorrect/i)).toBeVisible();

	// "Use single sign-on" is <a href="#">: a same-document switch, not a reload.
	await frame.evaluate(() => Reflect.set(window, "__neutronProbe", true));
	await frame.getByRole("link", { name: /use single sign-on/i }).click();
	// The committed document URL gains the fragment (a reload would not).
	await expect.poll(() => frame.evaluate(() => location.href.endsWith("#"))).toBe(true);
	await expect(frame.getByText(/log in to figma with saml sso/i)).toBeVisible();
	expect(await frame.evaluate(() => Reflect.get(window, "__neutronProbe"))).toBe(true);
	await frame.getByRole("link", { name: /log in with google or a password/i }).click();

	// Google SSO opens a popup and polls for it to close or set a cookie.
	// Before popups were windows, Figma reported "window-not-found" at once.
	const before = await tabs.count();
	await frame.getByRole("button", { name: /continue with google/i }).click();
	await expect(tabs).toHaveCount(before + 1);
	let popup: Frame | undefined;
	await expect
		.poll(() => {
			popup = page
				.frames()
				.find((f) => /accounts\.google\.com/.test(decodeURIComponent(f.url())));
			return !!popup;
		})
		.toBe(true);
	await page.waitForTimeout(2_000);
	await expect(frame.getByText(/unable to get profile information/i)).toBeHidden();

	// Synthetic final callback: Figma's finish page writes its result cookie
	// and closes the popup. A token error (not "window"/"cookie not found")
	// shows the opener read the popup's cookie.
	const steps: string[] = [];
	const onRequest = (request: { postData(): string | null }) => {
		for (const match of (request.postData() ?? "").matchAll(
			/GoogleSSOError[^}]*?"step":"([a-z-]+)"/g,
		))
			if (match[1]) steps.push(match[1]);
	};
	page.on("request", onRequest);
	if (!popup) throw new Error("Google popup missing");
	await pageScript(
		popup,
		'location.href="https://www.figma.com/finish_google_sso?state=neutron-synthetic&code=neutron-synthetic"',
	);
	await expect(tabs).toHaveCount(before);
	await expect(frame.getByText(/unable to get profile information/i)).toBeVisible();
	await expect.poll(() => steps, { timeout: 30_000 }).toContain("token-not-found");
	page.off("request", onRequest);

	// The grant page's redeem link with a synthetic secret: the desktop app must
	// pass it to its own sign-in view, which posts it to Figma.
	const redeem = page.waitForResponse(
		(r) =>
			r.request().method() === "POST" &&
			proxiedPath("/api/session/app_auth/redeem").test(r.url()),
	);
	await pageScript(
		frame,
		'window.opener=null;location.replace("figma://app_auth/redeem?g_secret=neutron-synthetic")',
	);
	const redeemed = await redeem;
	expect(redeemed.status()).toBe(400);
	expect(redeemed.frame().name()).toMatch(/^neutron:\d+$/);
	await expect(tabs).toHaveCount(0);
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
			let loginFrame: Frame | undefined;
			let signInSteps = false;
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
								if (vendorUI) {
									loginFrame = frame;
									break;
								}
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
				if (target.name === "Figma" && loginFrame) {
					await figmaSignInSteps(page, loginFrame);
					signInSteps = true;
					expect(extraPages, "A sign-in step escaped into a separate Chromium page").toBe(
						0,
					);
					expect(directGrantNavigation, "A sign-in step left the proxy").toBe(false);
					await expect(page.locator("#runtime-state")).toHaveText("Application running");
				}
			} finally {
				console.log(`${target.name} login probe:`, {
					extraPages,
					directGrantNavigation,
					proxiedLoginWindow,
					vendorUI,
					signInSteps,
				});
				await originalWindows.dispose();
			}
		});
	});
