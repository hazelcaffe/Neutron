import { expect, test } from "@playwright/test";
import { downloadFile } from "./shell";

test("import menu, Run and Stop, logs shortcut, Files download and confirmed removal", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await expect(page.locator("#application-select")).toBeDisabled();
	await expect(page.locator("#stop-button")).toBeDisabled();

	await page.locator("#import-button").click();
	const folder = page.getByRole("menuitem", { name: "Resources folder…", exact: true });
	await expect(folder).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(folder).toBeHidden();

	await page.getByRole("button", { name: "Try the example app" }).click();
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	await expect(page.frameLocator("iframe[name='neutron:1']").locator("#note")).toBeVisible();
	await expect(page.locator("#stop-button")).toBeEnabled();

	// The app's iframe has focus after launch; shortcuts belong to the shell page.
	await page.locator(".brand").click();
	await page.keyboard.press("Control+Backquote");
	await expect(page.locator("#console-output")).toContainText("Application ready");
	await page.keyboard.press("Control+Backquote");
	await expect(page.locator("#console-output")).toBeHidden();

	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await expect(page.locator("#stop-button")).toBeDisabled();
	expect((await downloadFile(page, "/package.json")).toString()).toContain("neutron-notes");

	await page.locator("#settings-button").click();
	await page.locator("#remove-app").click();
	await page.locator("#confirm-remove").click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await expect(page.locator("#application-select")).toBeDisabled();
	await expect(page.locator("#application-select")).toHaveValue("");
	await expect(page.getByRole("heading", { name: "Run an Electron app" })).toBeVisible();
});
