import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { test } from "./package-profile";
import { showLogs } from "./shell";

const resources = process.env.NEUTRON_SIGNAL_RESOURCES;
test.skip(!resources, "Set NEUTRON_SIGNAL_RESOURCES to an official extracted resources directory.");

// Signal's own logs (in its virtual filesystem, stored in OPFS) explain failures.
test.afterEach(async ({ page }, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return;
	const logs = await page
		.evaluate(async () => {
			const found: string[] = [];
			const walk = async (directory: FileSystemDirectoryHandle, path: string) => {
				for await (const [name, handle] of directory as unknown as AsyncIterable<
					[string, FileSystemHandle]
				>) {
					const full = `${path}/${name}`;
					if (handle instanceof FileSystemDirectoryHandle) await walk(handle, full);
					else if (/\/Signal\/logs\/[^/]+\.log$/.test(full))
						found.push(
							`== ${full}\n${await (await (handle as FileSystemFileHandle).getFile()).text()}`,
						);
				}
			};
			await walk(await navigator.storage.getDirectory(), "");
			return found.join("\n");
		})
		.catch((error: unknown) => String(error));
	const path = testInfo.outputPath("signal-logs.txt");
	await writeFile(path, logs);
	await testInfo.attach("signal-logs", { path, contentType: "text/plain" });
});

// Signal shows its link-a-device QR code only after libsignal (the WebAssembly
// build) has generated the provisioning key pair, connected to Signal's server
// over libsignal-net (TCP through Wisp, TLS in BoringSSL with Signal's pinned
// roots), and received the provisioning address.
test("official Signal Desktop links through the real libsignal: its QR code carries provisioning addresses that refresh", async ({
	page,
}) => {
	test.setTimeout(420_000);
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 60_000 });
	await page.locator("#folder-input").setInputFiles(resources as string);
	const readQR = async () => {
		try {
			// Signal opens other windows first; read whichever one is showing.
			const image = PNG.sync.read(await page.screenshot());
			return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? "";
		} catch {
			return "";
		}
	};
	const provisioning = /^sgnl:\/\/linkdevice\?uuid=[\w%-]{16,}&pub_key=[\w%-]{40,}/;
	let first = "";
	await expect
		.poll(async () => (first = await readQR()), { timeout: 180_000, intervals: [2000] })
		.toMatch(provisioning);
	// Signal replaces the code with a fresh provisioning address every 45s,
	// over a new connection; that has to keep working while someone scans.
	await expect
		.poll(
			async () => {
				const link = await readQR();
				return provisioning.test(link) && link !== first;
			},
			{ timeout: 120_000, intervals: [2000] },
		)
		.toBe(true);
	const logs = await showLogs(page);
	expect(logs).not.toContain("libsignal-client.node: using a fallback");
	expect(logs).not.toMatch(/libsignal-client.*(WebAssembly build|not prepared)/);
});
