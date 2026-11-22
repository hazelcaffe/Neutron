import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./package-profile";

const resources = process.env.NEUTRON_JOPLIN_RESOURCES;
test.skip(!resources, "Set NEUTRON_JOPLIN_RESOURCES to an official extracted resources directory.");
// A 1×1 PNG. Compare the actual resource, not just the file in the import dialog.
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=",
	"base64",
);

test("official Joplin attaches a PNG and reopens the note with its resource intact", async ({
	page,
}, info) => {
	test.setTimeout(300_000);
	const title = `Attachment ${randomUUID().slice(0, 8)}`,
		filename = `${title}.png`;
	const state = page.locator("#runtime-state"),
		app = page.frameLocator('iframe[data-neutron-id="1"]');
	await page.goto("/");
	await expect(state).toHaveText("Runtime ready");
	await page.locator("#folder-input").setInputFiles(resources as string);
	// Account for the full resource import before starting the application UI
	// deadline, particularly when another large package is importing in parallel.
	await expect(page.locator("#application-select option")).toContainText("@joplin/app-desktop", {
		timeout: 150_000,
	});
	const newNote = app.locator(".new-note-button").first();
	await expect(newNote).toBeVisible({ timeout: 75_000 });
	await newNote.click();
	const titleInput = app.locator(".note-title-wrapper input");
	await titleInput.fill(title);
	await titleInput.press("Tab");
	await expect(app.getByText(title, { exact: true }).first()).toBeVisible();
	const picked = page.waitForEvent("filechooser");
	await app.getByRole("button", { name: "Attach file", exact: true }).click();
	await (await picked).setFiles({ name: filename, mimeType: "image/png", buffer: png });
	// Joplin's Markdown editor can be a textarea or CodeMirror depending on
	// preferences. Its link points to a resource ID, not the external filename.
	const reference = async () =>
		app.locator("textarea,.cm-content").evaluateAll((nodes, name) => {
			for (const node of nodes) {
				const text =
					node instanceof HTMLTextAreaElement ? node.value : node.textContent || "";
				const start = text.indexOf(`![${name}](:/`);
				if (start >= 0) return text.slice(start).match(/\]\(:\/([0-9a-f]{32})\)/)?.[1];
			}
			return null;
		}, filename);
	await expect.poll(reference, { timeout: 20_000 }).toMatch(/^[0-9a-f]{32}$/);
	const id = await reference();
	const appId = await page.locator("#application-select").inputValue();
	const bytes = () =>
		page.evaluate(
			async ({ appId, id }) => {
				let dir = await navigator.storage.getDirectory();
				for (const part of [
					"neutron",
					"apps",
					appId,
					"fs",
					"home",
					"user",
					".config",
					"joplin-desktop",
					"resources",
				])
					dir = await dir.getDirectoryHandle(part);
				const file = await (await dir.getFileHandle(`${id}.png`)).getFile();
				return [...new Uint8Array(await file.arrayBuffer())];
			},
			{ appId, id },
		);
	// Select another note to finish and save the edit before shutting down.
	await newNote.click();
	await expect(titleInput).not.toHaveValue(title);
	await page.locator("#stop-button").click();
	await expect(state).toHaveText("Runtime ready", { timeout: 30_000 });
	expect(await bytes()).toEqual([...png]);
	await page.reload();
	await expect(state).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	const note = app.getByText(title, { exact: true }).first();
	await expect(note).toBeVisible({ timeout: 75_000 });
	await note.click();
	await expect(titleInput).toHaveValue(title);
	await expect.poll(reference, { timeout: 15_000 }).toBe(id);
	expect(await bytes()).toEqual([...png]);
	await page.screenshot({ path: info.outputPath("reopened-note.png") });
});
