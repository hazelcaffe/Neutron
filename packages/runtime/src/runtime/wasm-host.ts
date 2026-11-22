import { hostScope } from "./transport";

// Minimal built-ins for synchronous wasm-bindgen bindings shipped as runtime
// assets. Never use an imported app's resource base or its network settings.
export const { TextDecoder, TextEncoder } = globalThis;
export function readFileSync(filename: string): Uint8Array {
	const url = new URL(filename, hostScope.location.href);
	if (url.origin !== hostScope.location.origin || !url.pathname.startsWith("/vendor/"))
		throw new Error(`Invalid WASM asset location: ${filename}`);
	const xhr = new hostScope.XMLHttpRequest();
	xhr.open("GET", url.href, false);
	if (typeof window === "undefined") xhr.responseType = "arraybuffer";
	else xhr.overrideMimeType("text/plain; charset=x-user-defined");
	xhr.send();
	if (xhr.status !== 200) throw new Error(`WASM asset ${filename} returned HTTP ${xhr.status}`);
	return xhr.responseType === "arraybuffer"
		? new Uint8Array(xhr.response)
		: Uint8Array.from(xhr.responseText, (c) => c.charCodeAt(0) & 255);
}
