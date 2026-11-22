import { createAsar } from "@neutron/runtime/asar";
import { expect, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";
import { saveSettings } from "./shell";

async function expectFillsViewport(page: Page, id: number): Promise<void> {
	await expect
		.poll(async () => {
			const viewport = await page.locator("#desktop").boundingBox();
			const frame = await page.locator(`iframe[data-neutron-id='${id}']`).boundingBox();
			return Boolean(
				viewport &&
					frame &&
					["x", "y", "width", "height"].every(
						(key) => Math.abs(Reflect.get(viewport, key) - Reflect.get(frame, key)) < 1,
					),
			);
		})
		.toBe(true);
}

test("app windows fill one viewport, switch without reloading, and ignore desktop geometry", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"viewport-test","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain}=require('electron');
function open(){const w=new BrowserWindow({width:310,height:210,x:80,y:90,frame:true,show:false,webPreferences:{nodeIntegration:true}});w.loadFile('index.html').then(()=>w.show());return w;}
ipcMain.on('new-window',open);
ipcMain.handle('geometry',event=>{const w=BrowserWindow.fromWebContents(event.sender);w.setBounds({x:150,y:200,width:280,height:190});w.unmaximize();w.center();return w.getBounds();});
ipcMain.on('hide-window',event=>BrowserWindow.fromWebContents(event.sender).hide());
app.whenReady().then(open);`,
		"index.html": `<html><head><title>Viewport app</title></head><body><input aria-label="App state"><button id="new">New window</button><button id="geometry">Change geometry</button><button id="hide">Hide</button><button id="close">Close window</button><pre id="bounds"></pre><script>
const {ipcRenderer}=require('electron');document.querySelector('#new').onclick=()=>ipcRenderer.send('new-window');document.querySelector('#geometry').onclick=async()=>document.querySelector('#bounds').textContent=JSON.stringify(await ipcRenderer.invoke('geometry'));document.querySelector('#hide').onclick=()=>ipcRenderer.send('hide-window');document.querySelector('#close').onclick=()=>window.close();
</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const first = page.frameLocator("iframe[data-neutron-id='1']");
	await expect(first.getByLabel("App state")).toBeVisible();
	await expectFillsViewport(page, 1);
	await expect(page.locator(".window-titlebar")).toHaveCount(0);
	await expect(page.locator("#window-tabs")).toBeHidden();
	await first.getByLabel("App state").fill("first state");
	await first.locator("#new").click();
	const second = page.frameLocator("iframe[data-neutron-id='2']");
	await expect(second.getByLabel("App state")).toBeVisible();
	await second.getByLabel("App state").fill("second state");
	await expect(page.locator("iframe[data-neutron-id='1']")).toBeHidden();
	await expectFillsViewport(page, 2);
	await expect(page.locator("#window-tabs")).toBeVisible();
	await expect(page.getByRole("tab", { name: "Viewport app (2)" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await page.getByRole("tab", { name: "Viewport app (1)" }).click();
	await expect(page.getByRole("tab", { name: "Viewport app (1)" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(first.getByLabel("App state")).toHaveValue("first state");
	await expect(page.locator("iframe[data-neutron-id='2']")).toBeHidden();
	await first.locator("#geometry").click();
	const area = await page.locator("#desktop").boundingBox();
	await expect(first.locator("#bounds")).toHaveText(
		JSON.stringify({ x: 0, y: 0, width: area?.width, height: area?.height }),
	);
	await expectFillsViewport(page, 1);
	await page.locator("#logs-button").click();
	await expectFillsViewport(page, 1);
	await page.getByRole("button", { name: "Close logs" }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await expectFillsViewport(page, 1);
	await first.locator("#close").click();
	await expect(second.getByLabel("App state")).toBeVisible();
	await expect(second.getByLabel("App state")).toHaveValue("second state");
	await expect(page.locator("#window-tabs")).toBeHidden();
	await expectFillsViewport(page, 2);
	await second.locator("#hide").click();
	await expect(page.locator("iframe[data-neutron-id='2']")).toBeHidden();
	await expect(page.locator("#window-tabs")).toBeVisible();
	await expect(page.locator("#no-window")).toBeVisible();
	await page.getByRole("tab", { name: "Viewport app, hidden" }).click();
	await expect(second.getByLabel("App state")).toBeVisible();
	await expect(page.locator("#no-window")).toBeHidden();
	await second.locator("#new").click();
	const third = page.frameLocator("iframe[data-neutron-id='3']");
	await expect(third.getByLabel("App state")).toBeVisible();
	await page.getByRole("button", { name: "Close Viewport app (3)" }).click();
	await expect(page.locator("iframe[data-neutron-id='3']")).toHaveCount(0);
	await expect(second.getByLabel("App state")).toHaveValue("second state");
	await expect(page.locator("#window-tabs")).toBeHidden();
});

test("menu bar is opt-in, saved with settings, and persists across reload", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.getByRole("button", { name: "Try the example app" }).click();
	await expect(page.frameLocator("iframe[data-neutron-id='1']").locator("#note")).toBeVisible();
	await expect(page.locator(".menu-row")).toBeHidden();
	await page.locator("#settings-button").click();
	const toggle = page.getByLabel("Show application menu bar");
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await saveSettings(page);
	await expect(page.locator(".menu-row")).toBeVisible();
	const menus = page.locator("#application-menu > button");
	await menus.filter({ hasText: "File" }).click();
	await menus.filter({ hasText: "View" }).click();
	await expect(page.locator('#application-menu > button[aria-expanded="true"]')).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expectFillsViewport(page, 1);
	await page.locator("#stop-button").click();
	await page.reload();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(page.locator(".menu-row")).toBeVisible();
	await page.locator("#settings-button").click();
	await expect(toggle).toBeChecked();
	await toggle.uncheck();
	await saveSettings(page);
	await expect(page.locator(".menu-row")).toBeHidden();
	await expectFillsViewport(page, 1);
});

test("a window the app never shows can be revealed from its tab", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"hidden-window","main":"main.cjs","version":"1"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,title:'Hidden editor'});w.loadFile('index.html');});`,
		"index.html":
			'<html><head><title>Hidden editor</title></head><body><textarea aria-label="Draft"></textarea></body></html>',
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const tab = page.getByRole("tab", { name: "Hidden editor, hidden" });
	await expect(tab).toBeVisible();
	await expect(page.locator("#no-window")).toBeVisible();
	await expect(page.locator("#no-window-show")).toHaveText("Show Hidden editor");
	await tab.click();
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.getByLabel("Draft")).toBeVisible();
	await expect(page.locator("#no-window")).toBeHidden();
	await expect(page.locator("#window-tabs")).toBeHidden();
	await expectFillsViewport(page, 1);
});
