import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { downloadFile, saveSettings } from "./shell";

const payload = (files: Record<string, Uint8Array>) => ({
	name: "resources.zip",
	mimeType: "application/zip",
	buffer: Buffer.from(zipSync(files)),
});

test("resources folder keeps companion files and sibling archives across a reload", async ({
	page,
}) => {
	const root = await mkdtemp(join(tmpdir(), "neutron-folder-"));
	const source = join(root, "source");
	const resources = join(root, "resources");
	await mkdir(source);
	await mkdir(resources);
	try {
		await writeFile(
			join(source, "package.json"),
			'{"name":"resources-app","version":"1.0.0","main":"main.cjs"}',
		);
		await writeFile(
			join(source, "main.cjs"),
			`const {app,BrowserWindow}=require('electron');const fs=require('fs');const path=require('path');
const result={appPath:app.getAppPath(),resourcesPath:process.resourcesPath,unpacked:require('./external.json'),secondary:require('module')._load('../obsidian.asar/secondary.cjs',module),loose:fs.readFileSync(path.join(process.resourcesPath,'extra.txt'),'utf8'),archiveBytes:fs.readFileSync(path.join(process.resourcesPath,'obsidian.asar')).length};
app.setAppPath(path.join(process.resourcesPath,'obsidian.asar'));
app.whenReady().then(async()=>{const w=new BrowserWindow();await w.loadFile('index.html');await w.webContents.executeJavaScript('document.querySelector("#result").textContent='+JSON.stringify(JSON.stringify(result)));});`,
		);
		await writeFile(
			join(source, "index.html"),
			'<html><head><title>Resource bundle</title></head><body><pre id="result"></pre></body></html>',
		);
		await writeFile(join(source, "external.json"), '{"fromUnpacked":true}');
		await createPackageWithOptions(source, join(resources, "app.asar"), {
			unpack: "external.json",
		});
		const secondary = createAsar({
			"package.json": '{"name":"obsidian-dev","version":"1.15.1"}',
			"secondary.cjs": "module.exports='sibling loaded';",
			"index.html":
				'<html><head><title>Secondary archive</title></head><body><pre id="result"></pre></body></html>',
		});
		await writeFile(join(resources, "obsidian.asar"), secondary);
		await writeFile(join(resources, "extra.txt"), "loose resource");
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#folder-input").setInputFiles(resources);
		const app = page.frameLocator("iframe[name='neutron:1']");
		await expect(app.locator("#result")).toContainText("sibling loaded");
		await expect(page.locator("iframe[name='neutron:1']")).toHaveAttribute(
			"src",
			/file%3A%2F%2F%2Fneutron%2Fresources%2Fobsidian\.asar%2Findex\.html$/,
		);
		expect(JSON.parse((await app.locator("#result").textContent()) || "null")).toEqual({
			appPath: "/neutron/resources/app.asar",
			resourcesPath: "/neutron/resources",
			unpacked: { fromUnpacked: true },
			secondary: "sibling loaded",
			loose: "loose resource",
			archiveBytes: secondary.length,
		});
		await page.locator("#stop-button").click();
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.reload();
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#launch-button").click();
		await expect(
			page.frameLocator("iframe[name='neutron:1']").locator("#result"),
		).toContainText(`"archiveBytes":${secondary.length}`);
		expect((await downloadFile(page, "/neutron/resources/extra.txt")).toString()).toBe(
			"loose resource",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing index.js is reviewed before execution; explicit main selection works", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	const archive = createAsar({
		"package.json": '{"name":"obsidian-dev","version":"1.15.1"}',
		"bootstrap.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow().loadFile('index.html'));`,
		"index.html":
			"<html><head><title>Chosen entry</title></head><body>Selected bootstrap ran.</body></html>",
	});
	await page.locator("#zip-input").setInputFiles(payload({ "resources/obsidian.asar": archive }));
	await expect(page.locator("#import-review")).toBeVisible();
	await expect(page.locator("#import-issue")).toContainText("does not declare a main entry");
	await expect(page.locator("#finish-import")).toBeDisabled();
	await expect(page.locator(".runtime-window")).toHaveCount(0);
	await page
		.locator("#entry-select")
		.selectOption("/neutron/resources/obsidian.asar/bootstrap.cjs");
	await page.locator("#finish-import").click();
	await expect(page.frameLocator("iframe[name='neutron:1']").locator("body")).toHaveText(
		"Selected bootstrap ran.",
	);
});

test("file timestamps set by the app survive a metadata-only write and OPFS remount", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"timestamp-roundtrip","version":"1","main":"main.cjs"}',
		"main.cjs": `const fs=require('node:fs'); const {app,BrowserWindow,ipcMain}=require('electron');
const file='/tmp/dated-file';if(!fs.existsSync(file)){fs.writeFileSync(file,'unchanged bytes');fs.utimesSync(file,946684800,946684800);}
ipcMain.handle('time',()=>fs.statSync(file).mtimeMs);
app.whenReady().then(()=>new BrowserWindow({webPreferences:{nodeIntegration:true}}).loadFile('page.html'));`,
		"page.html": `<pre id="times"></pre><script>require('electron').ipcRenderer.invoke('time').then(main=>document.querySelector('#times').textContent=[main,require('node:fs').statSync('/tmp/dated-file').mtimeMs].join(','));</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(payload({ "resources/app.asar": archive }));
	const times = page.frameLocator('iframe[data-neutron-id="1"]').locator("#times");
	await expect(times).toHaveText("946684800000,946684800000");
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.reload();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(times).toHaveText("946684800000,946684800000");
});

test("permissive APIs keep startup running; strict mode remains available", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"fallback-app","version":"1.0.0","main":"main.cjs"}',
		"native.node": "placeholder",
		"main.cjs": `const {app,BrowserWindow,autoUpdater,TouchBar,desktopCapturer}=require('electron');
const addon=require('./native.node');addon.initialize().finish();require('optional-native-package').initialize();
app.setLoginItemSettings({openAtLogin:false});new TouchBar({items:[new TouchBar.TouchBarButton({label:'test'})]});
app.whenReady().then(async()=>{await autoUpdater.checkForUpdates();const sources=await desktopCapturer.getSources();await new Promise(resolve=>require('child_process').spawn('native-helper').once('exit',resolve));
const w=new BrowserWindow();w.setMinimumSize(240,200);w.webContents.debugger.attach();await w.loadFile('index.html');});`,
		"index.html":
			"<html><head><title>Fallbacks</title></head><body>Startup continued with fallbacks.</body></html>",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(payload({ "resources/app.asar": archive }));
	await expect(page.frameLocator("iframe[name='neutron:1']").locator("body")).toHaveText(
		"Startup continued with fallbacks.",
	);
	await page.locator("#logs-button").click();
	await expect(page.locator("#console-output")).toContainText("[compat]");
	await expect(page.locator("#console-output")).toContainText("native addon");
	await page.locator("#settings-button").click();
	await page.locator("#strict-apis").check();
	await saveSettings(page);
	// Run restarts the app that is already running.
	await page.locator("#launch-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Application error");
	await expect(page.locator("#console-output")).toContainText("ERR_UNSUPPORTED_API");
});

test("the toolbar, settings and logs stay usable at a narrow viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await expect(page.getByRole("heading", { name: "Run an Electron app" })).toBeVisible();
	for (const id of ["#import-button", "#logs-button", "#files-button", "#settings-button"])
		await expect(page.locator(id)).toBeInViewport();
	await page.locator("#settings-button").click();
	await expect(page.locator("#wisp-url")).toBeInViewport();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await page.locator("#logs-button").click();
	await expect(page.locator("#console-output")).toContainText("Service worker active");
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
	).toBe(true);
});
