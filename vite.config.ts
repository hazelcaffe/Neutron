import { neutron } from "@neutron/runtime/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ isPreview }) => ({
	// GitHub Pages serves this project at /Neutron/; see .github/workflows/pages.yml.
	base: process.env.NEUTRON_BASE || "/",
	plugins: [react(), neutron({ reloadOnChange: process.env.NEUTRON_HMR === "1" })],
	server: {
		// A page reload terminates the guest app, including unsaved work and
		// pending sign-in flows. Rebuild on edit but let the tester reload.
		hmr: process.env.NEUTRON_HMR === "1",
		// Extracted distributions and their profiles can be tens of gigabytes.
		watch: { ignored: ["**/.cache/**", "**/test-results/**", "**/playwright-report/**"] },
	},
	build: {
		target: "esnext",
		...(isPreview && process.env.NEUTRON_SWEEP_DIST
			? { outDir: process.env.NEUTRON_SWEEP_DIST }
			: {}),
	},
	optimizeDeps: { entries: ["index.html"] },
}));
