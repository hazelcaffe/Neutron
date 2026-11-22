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
