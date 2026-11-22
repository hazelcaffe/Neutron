import { expect, type Page } from "@playwright/test";

// Interactions with the Neutron UI that many specs share.

/** Saves the open Settings dialog and waits for it to close. */
export async function saveSettings(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
}

/** Opens the logs panel (if needed) and returns its text, e.g. for failure reports. */
export async function showLogs(page: Page): Promise<string> {
	await page.keyboard.press("Escape").catch(() => {});
	const button = page.locator("#logs-button");
	if ((await button.getAttribute("aria-pressed")) !== "true")
		await button.click({ timeout: 3000 });
	return (await page.locator("#console-output").textContent()) ?? "";
}

/** Downloads a file from the selected app's virtual filesystem via the Files dialog. */
export async function downloadFile(page: Page, path: string): Promise<Buffer> {
	await page.locator("#files-button").click();
	await page.locator("#file-search").fill(path);
	const entry = page.locator(".file-entry").filter({ hasText: path }).first();
	const [download] = await Promise.all([page.waitForEvent("download"), entry.click()]);
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: /^Files/ })).toBeHidden();
	return Buffer.concat(chunks);
}
