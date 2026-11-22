import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	timeout: 45_000,
	use: {
		baseURL: "http://127.0.0.1:4173",
		headless: true,
		viewport: { width: 1440, height: 1000 },
	},
	webServer: [
		{
			command: process.env.NEUTRON_TEST_DEV
				? "pnpm dev --port 4173 --strictPort"
				: "pnpm preview --port 4173 --strictPort",
			port: 4173,
			reuseExistingServer: false,
		},
		{
			command: "node tests/network-fixture.mjs",
			url: "http://127.0.0.1:4174/health",
			reuseExistingServer: false,
		},
	],
	reporter: "list",
});
