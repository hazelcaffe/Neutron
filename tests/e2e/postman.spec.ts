import { expect } from "@playwright/test";
import { test } from "./package-profile";
import { showLogs } from "./shell";

const resources = process.env.NEUTRON_POSTMAN_RESOURCES;
test.skip(
	!resources,
	"Set NEUTRON_POSTMAN_RESOURCES to an extracted official resources directory.",
);
test.use({ actionTimeout: 15_000 });
test("official Postman sends a request and displays its response without an account", async ({
	page,
}, info) => {
	test.setTimeout(240_000);
	page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
	page.on("console", (message) => {
		if (message.type() === "error") console.log("BROWSER ERROR", message.text());
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#settings-button").click();
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4174/wisp/");
	await page.locator("#compat-platform").selectOption("win32");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await page.locator("#folder-input").setInputFiles(resources as string);
	let complete = false;
	try {
		await expect(page.locator("#import-progress")).toBeHidden({ timeout: 180_000 });
		await expect(page.locator("#application-select option")).toContainText("Postman");
		await page.waitForFunction(
			() =>
				document.querySelector("#runtime-state")?.textContent === "Application error" ||
				document.querySelector(".runtime-window"),
			undefined,
			{ timeout: 45_000 },
		);
		await expect(page.locator("#runtime-state")).not.toHaveText("Application error");
		await expect(page.locator(".runtime-window:visible").first()).toBeVisible({
			timeout: 30_000,
		});
		const app = page.locator(".runtime-window:visible > iframe").first().contentFrame();
		await expect(app.getByText("Continue without an account", { exact: true })).toBeVisible({
			timeout: 30_000,
		});
		await app.getByText("Continue without an account", { exact: true }).click();
		await expect(app.getByText("Continue without an account", { exact: true })).toBeHidden();
		await expect(app.locator("body")).toContainText(/Scratch Pad|Open Lightweight API Client/, {
			timeout: 30_000,
		});
		const lightweight = app.getByText("Open Lightweight API Client", { exact: true });
		if (await lightweight.isVisible()) {
			await lightweight.click();
			await expect(app.getByText("Send", { exact: true }).first()).toBeVisible({
				timeout: 45_000,
			});
		} else {
			await expect(app.getByText("Create a request", { exact: true })).toBeVisible();
			await app.getByText("Create a request", { exact: true }).click();
		}
		const urlEditor = app
			.locator(".DraftEditor-root")
			.filter({ hasText: "Enter URL or paste text" })
			.locator('[contenteditable="true"]');
		await urlEditor.click();
		await page.keyboard.insertText("http://127.0.0.1:4175/api");
		await page.keyboard.press("Tab");
		const send = app.getByRole("button", { name: "Send", exact: true });
		await expect(send).toBeEnabled();
		await send.click();
		await expect(app.locator("body")).toContainText("through-wisp", { timeout: 30000 });
		await expect(page.locator("#runtime-state")).toHaveText("Application running");
		await page.screenshot({ path: info.outputPath("postman.png"), fullPage: true });
		complete = true;
	} finally {
		if (!complete && !page.isClosed()) {
			await page.locator("dialog[open]").evaluateAll((dialogs) => {
				for (const dialog of dialogs) (dialog as HTMLDialogElement).close();
			});
			console.log("RUNTIME LOG", await showLogs(page));
			for (const frame of page.frames().slice(1))
				console.log(
					"FRAME",
					frame.url(),
					(
						(await frame
							.locator("body")
							.textContent({ timeout: 2000 })
							.catch(() => "unavailable")) || ""
					).slice(-5000),
				);
		}
	}
});
