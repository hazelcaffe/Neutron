import { defineConfig } from "@playwright/test";

// Error-context snapshots can contain links with live grant parameters.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "browser-login.spec.ts",
	outputDir: "../.cache/figma-login/results",
	workers: 1,
	timeout: 240_000,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4251",
		viewport: { width: 1440, height: 1000 },
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer:
		process.env.NEUTRON_FIGMA_RESOURCES || process.env.NEUTRON_GITHUB_DESKTOP_RESOURCES
			? {
					command: "pnpm exec vite preview --host 127.0.0.1 --port 4251 --strictPort",
					cwd: "..",
					env: {
						NEUTRON_SWEEP_DIST:
							process.env.NEUTRON_SWEEP_DIST || ".cache/figma-login/preview",
					},
					url: "http://127.0.0.1:4251/__neutron_dev__",
					reuseExistingServer: false,
					stderr: "ignore",
				}
			: undefined,
});
