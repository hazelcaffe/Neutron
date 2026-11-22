import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test as base } from "@playwright/test";

// Chromium's incognito OPFS quota depends on memory pressure. Large official
// distributions need a disk-backed profile, especially during parallel runs.
export const test = base.extend({
	context: async ({ playwright, baseURL, viewport, headless }, use) => {
		const root = resolve(
			process.env.NEUTRON_APP_CACHE || ".cache/compat-apps",
			"test-profiles",
		);
		await mkdir(root, { recursive: true });
		const profile = await mkdtemp(join(root, "package-"));
		try {
			const context = await playwright.chromium.launchPersistentContext(profile, {
				baseURL,
				headless,
				viewport,
			});
			try {
				await use(context);
			} finally {
				await context.close();
			}
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
	},
});
