import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import { test } from "./package-profile";
import { saveSettings, showLogs } from "./shell";

const resources = process.env.NEUTRON_VESKTOP_RESOURCES;
test.skip(
	!resources,
	"Set NEUTRON_VESKTOP_RESOURCES to an official extracted resources directory.",
);

// Discord's settings require an account. Open the same Vencord section
// panels Discord's settings layout would show (Vesktop's own panel and the
// Vencord tab) in a Discord modal on the account-free login page.
async function openPanel(frame: Frame, key: string): Promise<Locator> {
	await frame.evaluate(async (key) => {
		const vencord = Reflect.get(window, "Vencord");
		const { React, openModal, Modal, closeAllModals } = vencord.Webpack.Common;
		closeAllModals();
		const root = vencord.Plugins.plugins.Settings.buildLayout({
			key: "$Root",
			buildLayout: () => [],
		});
		type Node = { key: string; Component?: unknown; buildLayout?(): Node[] };
		const panels = new Map<string, unknown>();
		const walk = (node: Node) => {
			if (node.Component) panels.set(node.key.replace(/_custom$/, ""), node.Component);
			for (const child of node.buildLayout?.() ?? []) walk(child);
		};
		walk(root.find((node: Node) => node?.key === "vencord_section"));
		openModal((props: object) =>
			React.createElement(
				Modal,
				{ ...props, size: "lg", title: key },
				React.createElement(
					"div",
					{ "data-settings-panel": key },
					React.createElement(panels.get(key)),
				),
			),
		);
	}, key);
	return frame.locator(`[data-settings-panel="${key}"]`).last();
}

async function discord(page: Page): Promise<Frame> {
	let found: Frame | undefined;
	await expect
		.poll(
			async () => {
				for (const frame of page.frames())
					if (
						/discord\.com/.test(decodeURIComponent(frame.url())) &&
						(await frame
							.getByText("Welcome back!")
							.isVisible()
							.catch(() => false)) &&
						(await frame
							.evaluate(
								() => !!Reflect.get(window, "Vencord")?.Webpack?.Common?.openModal,
							)
							.catch(() => false))
					) {
						found = frame;
						return true;
					}
				return false;
			},
			{ timeout: 150_000, intervals: [1000] },
		)
		.toBe(true);
	return found as Frame;
}

const vesktopSettings = (frame: Frame) =>
	frame.evaluate(() => Reflect.get(window, "VesktopNative").settings.get());

test("official Vesktop settings render, save, open the QuickCSS editor and survive relaunch and reload", async ({
	page,
}) => {
	test.setTimeout(600_000);
	const state = page.locator("#runtime-state");
	let complete = false;
	try {
		await page.goto("/");
		await expect(state).toHaveText("Runtime ready");
		await page.locator("#settings-button").click();
		await page.locator("#compat-platform").selectOption("linux");
		await saveSettings(page);
		await page.locator("#folder-input").setInputFiles(resources as string);
		await expect(page.locator("#application-select option:checked")).toHaveText(/vesktop/i, {
			timeout: 150_000,
		});
		// First launch setup.
		let setup: Frame | undefined;
		await expect
			.poll(
				async () => {
					for (const frame of page.frames())
						if (
							await frame
								.getByRole("button", { name: "Submit", exact: true })
								.isVisible()
								.catch(() => false)
						)
							setup = frame;
					return !!setup;
				},
				{ timeout: 90_000 },
			)
			.toBe(true);
		await setup?.getByRole("button", { name: "Submit", exact: true }).click();

		let frame = await discord(page);
		let panel = await openPanel(frame, "vesktop");
		await expect(panel).toContainText("Discord Branch");
		await expect(panel).not.toContainText("Oh no!");
		const before = (await vesktopSettings(frame)).staticTitle;
		await panel.getByText("Static Title", { exact: true }).click();
		await expect.poll(async () => (await vesktopSettings(frame)).staticTitle).toBe(!before);

		panel = await openPanel(frame, "vencord_main");
		await expect(panel).toContainText("Enable Custom CSS");
		await panel.getByText("Edit QuickCSS", { exact: true }).click();
		await expect(
			page.locator(".window-tab").filter({ hasText: "QuickCSS Editor" }),
		).toBeVisible({
			timeout: 30_000,
		});
		await expect
			.poll(
				async () => {
					for (const candidate of page.frames())
						if (
							/monaco-editor/.test(decodeURIComponent(candidate.url())) &&
							(await candidate.locator(".monaco-editor").count())
						)
							return true;
					return false;
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		await page
			.locator(".window-tab [role=tab]")
			.filter({ hasText: /^Vesktop$/ })
			.click();

		// Vencord's restart action relaunches the app; the setting persists.
		panel = await openPanel(frame, "vencord_main");
		await panel.getByText("Relaunch Discord", { exact: true }).click();
		const previous = frame;
		await expect.poll(() => previous.isDetached(), { timeout: 30_000 }).toBe(true);
		frame = await discord(page);
		await expect(state).toHaveText("Application running");
		expect((await vesktopSettings(frame)).staticTitle).toBe(!before);

		await page.locator("#stop-button").click();
		await expect(state).toHaveText("Runtime ready");
		await page.reload();
		await expect(state).toHaveText("Runtime ready");
		await page.locator("#launch-button").click();
		frame = await discord(page);
		expect((await vesktopSettings(frame)).staticTitle).toBe(!before);
		panel = await openPanel(frame, "vesktop");
		const toggle = panel
			.getByText("Static Title", { exact: true })
			.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]")
			.locator("input[type=checkbox]")
			.first();
		await expect(toggle).toBeChecked({ checked: !before });
		complete = true;
	} finally {
		if (!complete && !page.isClosed()) console.log("RUNTIME LOG\n", await showLogs(page));
	}
});
