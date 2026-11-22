import { expect, test } from "@playwright/test";
import { showLogs } from "./shell";

const resources = process.env.NEUTRON_OBSIDIAN_RESOURCES;
test.use({ actionTimeout: 15_000 });
test("official Obsidian creates and persists a note", async ({ page }, info) => {
	test.skip(
		!resources,
		"Set NEUTRON_OBSIDIAN_RESOURCES to an extracted official resources directory.",
	);
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.log("PAGE ERROR", error.message);
	});
	page.on("console", (message) => {
		if (message.type() === "error") console.log("BROWSER ERROR", message.text());
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#folder-input").setInputFiles(resources as string);
	let complete = false;
	try {
		await page.waitForFunction(
			() =>
				document.querySelector("#runtime-state")?.textContent === "Application error" ||
				document.querySelector(".runtime-window"),
			undefined,
			{ timeout: 30_000 },
		);
		await expect(page.locator("#runtime-state")).not.toHaveText("Application error");
		await expect(page.locator(".runtime-window:visible").first()).toBeVisible({
			timeout: 30_000,
		});
		const frame = page.frameLocator("iframe[data-neutron-id='1']");
		await expect(frame.locator("body")).toContainText("Create", { timeout: 30_000 });
		await frame.getByRole("button", { name: "Create", exact: true }).click();
		await frame.getByPlaceholder("Vault name", { exact: true }).fill("Browser vault");
		page.once("dialog", (dialog) => void dialog.accept("/home/user/Documents"));
		await frame.getByRole("button", { name: "Browse", exact: true }).click();
		await frame.getByRole("button", { name: "Create", exact: true }).last().click();
		await expect(page.locator("iframe[data-neutron-id='2']")).toBeVisible({ timeout: 30_000 });
		const editor = page.frameLocator("iframe[data-neutron-id='2']");
		await expect(editor.locator(".workspace")).toBeVisible({ timeout: 30_000 });
		await editor.getByText("New note", { exact: true }).click();
		const content = editor.locator(".cm-content[contenteditable='true']").first();
		await content.click();
		const note = "Saved from real Obsidian through Neutron and OPFS.";
		await page.keyboard.insertText(note);
		const filename = "/home/user/Documents/Browser vault/Untitled.md";
		await expect
			.poll(
				() =>
					editor
						.locator("body")
						.evaluate(
							(body, filename) =>
								Reflect.get(
									body.ownerDocument.defaultView as object,
									"require",
								)("fs").readFileSync(filename, "utf8"),
							filename,
						),
				{ timeout: 15_000 },
			)
			.toContain(note);
		await page.locator("#stop-button").click();
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.reload();
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#launch-button").click();
		const restored = page.frameLocator("iframe[data-neutron-id='1']");
		await expect(restored.locator(".workspace")).toBeVisible({ timeout: 30_000 });
		await restored.locator(".nav-file-title").filter({ hasText: "Untitled" }).first().click();
		await expect(restored.locator(".cm-content").first()).toContainText(note);
		await page.screenshot({ path: info.outputPath("obsidian.png"), fullPage: true });
		expect(errors).toEqual([]);
		complete = true;
	} finally {
		if (!complete && !page.isClosed()) {
			console.log("RUNTIME LOG\n", await showLogs(page));
			for (const frame of page.frames().slice(1))
				console.log(
					"FRAME",
					frame.url(),
					(
						(await frame
							.locator("body")
							.textContent({ timeout: 2000 })
							.catch(() => "unavailable")) || ""
					).slice(-6000),
				);
		}
	}
});
