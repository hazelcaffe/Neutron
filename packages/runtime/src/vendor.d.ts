declare module "crypto-browserify" {
	const value: Record<string, unknown>;
	export default value;
}
declare module "browserify-zlib" {
	const value: Record<string, unknown>;
	export default value;
}
declare module "stream-browserify" {
	export * from "node:stream";
}
declare module "querystring-es3" {
	import * as querystring from "node:querystring";
	export default querystring;
}
declare module "string_decoder/" {
	export * from "node:string_decoder";
}
declare module "pngjs/browser.js" {
	export { PNG } from "pngjs";
}
declare module "util/" {
	export * from "util";
}
declare module "url/" {
	export * from "url";
}
declare module "assert/" {
	import assert from "assert";
	export default assert;
}
declare module "libcurl.js" {
	export const libcurl: {
		readonly ready: boolean;
		readonly version: { curl: string; ssl: string } | null;
		get_error_string(code: number): string;
		load_wasm(url: string): Promise<void>;
		set_websocket(url: string): void;
		transport: string | unknown;
		fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
		WebSocket: typeof WebSocket;
		TLSSocket: new (
			host: string,
			port: number,
			options?: object,
		) => {
			send(data: Uint8Array): void;
			close(): void;
			onopen: (() => void) | null;
			onmessage: ((data: Uint8Array) => void) | null;
			onerror: ((code: number) => void) | null;
			onclose: (() => void) | null;
		};
		HTTPSession: new (options?: {
			enable_cookies?: boolean;
		}) => {
			fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
			close(): void;
			export_cookies(): string;
		};
	};
}
declare module "@mercuryworkshop/wisp-js/client" {
	interface WispStream {
		send(data: Uint8Array): void;
		close(): void;
		onmessage: ((data: Uint8Array) => void) | null;
		onclose: ((reason: number) => void) | null;
	}
	export const client: {
		WispWebSocket: unknown;
		ClientConnection: new (
			url: string,
		) => {
			onopen: (() => void) | null;
			onerror: (() => void) | null;
			onclose: (() => void) | null;
			create_stream(host: string, port: number, type?: string): WispStream;
			close(): void;
		};
	};
}
declare module "@ungap/structured-clone/json" {
	export function stringify(value: unknown): string;
	export function parse(value: string): unknown;
}
declare module "@mercuryworkshop/wisp-js/server" {
	export const logging: { ERROR: number; set_level(level: number): void };
	export const server: {
		options: { allow_private_ips: boolean; allow_loopback_ips: boolean };
		routeRequest(
			request: import("node:http").IncomingMessage,
			socket: import("node:stream").Duplex,
			head: Buffer,
		): void;
	};
}
declare module "path-win32" {
	const path: typeof import("node:path").win32;
	export default path;
}
declare module "@pkgjs/parseargs" {
	export const parseArgs: typeof import("node:util").parseArgs;
}
declare module "punycode/" {
	export * from "punycode";
}
