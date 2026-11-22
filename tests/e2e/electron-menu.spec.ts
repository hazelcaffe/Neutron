import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// Apps such as GitHub Desktop serialize Menu.getApplicationMenu() themselves
// (menu.items → item.submenu.items) and run items with
// menuItem.click(event, window, webContents).
test("application menus expose Electron's Menu/MenuItem model and click contract", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"menu-model","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,Menu,ipcMain}=require('electron');
const clicks=[];
app.whenReady().then(()=>{
  const w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'&File',id:'file',submenu:[
    {label:'Open',id:'open',accelerator:'CmdOrCtrl+O',click:(item,win,event)=>clicks.push([item.id,win===w,typeof event])},
    {type:'separator',id:'sep'},
    {label:'Check',id:'check',type:'checkbox'}]}]));
  ipcMain.handle('report',()=>{
    const menu=Menu.getApplicationMenu();
    const file=menu.items[0];
    const open=menu.getMenuItemById('open');
    open.click({preventDefault(){}},w,w.webContents);
    menu.getMenuItemById('check').click({preventDefault(){}},w,w.webContents);
    return {type:file.type,submenuIsMenu:file.submenu instanceof Menu,ids:file.submenu.items.map(i=>i.id),
      parent:open.menu===file.submenu,clicks,checked:menu.getMenuItemById('check').checked,
      zoomFactor:w.webContents.zoomFactor,zoomLevel:w.webContents.zoomLevel};
  });
  w.loadFile('index.html');
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{report:()=>ipcRenderer.invoke('report')});`,
		"index.html": `<button id="go" onclick="bridge.report().then(r=>document.querySelector('pre').textContent=JSON.stringify(r))">Go</button><pre></pre>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const app = page.frameLocator('iframe[data-neutron-id="1"]');
	await app.locator("#go").click();
	await expect(app.locator("pre")).toHaveText(
		JSON.stringify({
			type: "submenu",
			submenuIsMenu: true,
			ids: ["open", "sep", "check"],
			parent: true,
			clicks: [["open", true, "object"]],
			checked: true,
			zoomFactor: 1,
			zoomLevel: 0,
		}),
	);
});

// Menu.popup() is a context menu at the pointer: it must not replace the
// application menu, and it runs the clicked item before its close callback.
test("Menu.popup shows a context menu at the pointer and reports the choice", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"popup-menu","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,Menu,ipcMain}=require('electron');
app.whenReady().then(()=>{
  const w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',id:'file',submenu:[{label:'Quit',id:'quit-item'}]}]));
  ipcMain.handle('context',()=>new Promise(resolve=>{
    const events=[];
    const menu=Menu.buildFromTemplate([
      {label:'Discard changes',id:'discard',click:()=>events.push('click:discard')},
      {type:'separator'},
      {label:'Copy path',id:'copy',click:()=>events.push('click:copy')}]);
    menu.on('menu-will-close',()=>events.push('will-close'));
    menu.popup({window:w,callback:()=>{events.push('callback');resolve(events.join(',')+' app-menu='+Menu.getApplicationMenu().items[0].id)}});
  }));
  w.loadFile('index.html');
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{context:()=>ipcRenderer.invoke('context')});`,
		"index.html": `<div id="target" style="margin:40px;width:200px;height:80px;background:#ddd">Right-click me</div><pre></pre>
<script>document.querySelector('#target').addEventListener('contextmenu',e=>{e.preventDefault();bridge.context().then(v=>document.querySelector('pre').textContent+=v+'\\n')})</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const app = page.frameLocator('iframe[data-neutron-id="1"]');
	const target = app.locator("#target");
	await target.click({ button: "right", position: { x: 30, y: 20 } });
	const menu = page.locator("#context-menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem")).toHaveText(["Discard changes", "Copy path"]);
	const box = await page.locator('iframe[data-neutron-id="1"]').boundingBox();
	const menuBox = await menu.boundingBox();
	expect(Math.abs((menuBox?.x ?? 0) - ((box?.x ?? 0) + 70))).toBeLessThan(30);
	await menu.getByRole("menuitem", { name: "Copy path" }).click();
	await expect(app.locator("pre")).toHaveText("click:copy,will-close,callback app-menu=file");
	await expect(menu).toBeHidden();
	// Dismissing runs only the callback.
	await target.click({ button: "right" });
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(app.locator("pre")).toHaveText(
		"click:copy,will-close,callback app-menu=file\nwill-close,callback app-menu=file",
	);
});
