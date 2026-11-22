import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { downloadFile } from "./shell";

const resources = process.env.NEUTRON_DRAWIO_RESOURCES;
test.use({ actionTimeout: 15_000 });

test("official draw.io saves and reopens an edited diagram", async ({ page }, info) => {
	test.skip(
		!resources,
		"Set NEUTRON_DRAWIO_RESOURCES to the extracted official resources directory.",
	);
	test.setTimeout(180_000);
	const label = `Round trip ${randomUUID().slice(0, 8)}`;
	const filename = "/home/user/Documents/round-trip.drawio";
	const state = page.locator("#runtime-state");
	await page.goto("/");
	await expect(state).toHaveText("Runtime ready");
	await page.locator("#folder-input").setInputFiles(resources as string);

	const app = page.frameLocator(".runtime-window:visible > iframe");
	const canvas = app.locator(".geDiagramContainer");
	const shapeLabel = canvas.getByText(label, { exact: true });
	const fileMenu = app.getByRole("button", { name: "File", exact: true });
	await expect(canvas).toBeVisible({ timeout: 60_000 });
	await app.locator(".geSidebar").getByRole("button", { name: "Text", exact: true }).click();
	await canvas.getByText("Text", { exact: true }).dblclick();
	const editor = canvas.locator('[contenteditable="true"]');
	await expect(editor).toBeFocused();
	await page.keyboard.insertText(label);
	await page.keyboard.press("Escape");
	await expect(editor).toBeHidden();
	await expect(shapeLabel).toBeVisible();
	await page.screenshot({ path: info.outputPath("edited.png") });

	await test.step("Save to the virtual filesystem through draw.io's File menu", async () => {
		await fileMenu.click();
		await Promise.all([
			page.waitForEvent("dialog", { timeout: 15_000 }).then(async (dialog) => {
				expect(dialog.type()).toBe("prompt");
				await dialog.accept(filename);
			}),
			app.getByText("Save", { exact: true }).click(),
		]);
		await expect(app.getByRole("status")).toHaveText("All changes saved");
	});

	const exportSavedDiagram = async (artifact: string) => {
		const bytes = await downloadFile(page, filename);
		expect(bytes.toString("utf8")).toMatch(/<(?:mxfile|mxGraphModel)\b/);
		await writeFile(info.outputPath(artifact), bytes);
		return bytes;
	};
	const saved = await exportSavedDiagram("saved.drawio");
	const root = await page.evaluate(
		(xml) => new DOMParser().parseFromString(xml, "application/xml").documentElement.tagName,
		saved.toString("utf8"),
	);
	expect(["mxfile", "mxGraphModel"]).toContain(root);
	await page.locator("#stop-button").click();
	await expect(state).toHaveText("Runtime ready");
	await page.reload();
	await expect(state).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(canvas).toBeVisible({ timeout: 60_000 });
	expect(await exportSavedDiagram("after-reload.drawio")).toEqual(saved);
	await expect(shapeLabel).toHaveCount(0);
	await fileMenu.click();
	await app.getByText("Open Recent", { exact: true }).hover();
	await app.getByText(filename, { exact: true }).click();
	await expect(shapeLabel).toBeVisible();
	await page.screenshot({ path: info.outputPath("reopened.png") });
});
