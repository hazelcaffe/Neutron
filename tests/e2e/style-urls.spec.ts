import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("an escaped resource URL in a generated stylesheet loads the original package bytes", async ({
	page,
}) => {
	const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="9"/>';
	const archive = createAsar({
		"package.json": '{"name":"atlas-icons","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow().loadFile('index.html'));`,
		"icons/theme.mark.svg": icon,
		"index.html": `<!doctype html><div id="tile">Tile</div><script>
const style=document.createElement('style');
const image=CSS.escape(new URL('./icons/theme.mark.svg',location.href).href);
style.textContent=\`#tile { background-image: url('\${image}'); }\`;
document.head.append(style);
</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	const image = page.waitForResponse(
		(response) =>
			response.request().resourceType() === "image" && response.url().includes("theme"),
	);
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const response = await image;
	expect(decodeURIComponent(new URL(response.url()).pathname)).toMatch(
		/\/icons\/theme\.mark\.svg$/,
	);
	expect(response.status()).toBe(200);
	expect(await response.text()).toBe(icon);
});
