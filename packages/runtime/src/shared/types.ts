export type FileEntry =
	| { kind: "file"; data: Uint8Array; mtimeMs?: number }
	| { kind: "directory"; archive?: Uint8Array }
	| { kind: "symlink"; target: string };
export type Snapshot = Record<string, FileEntry>;
export interface FilePatch {
	path: string;
	entry: FileEntry | null;
}
export interface AppManifest {
	name: string;
	version: string;
	main: string;
	description?: string;
	type?: string;
}
export interface InstalledApp {
	id: string;
	manifest: AppManifest;
	filename: string;
	size: number;
	fileCount: number;
	installedAt: number;
	findings: Finding[];
	appPath?: string;
	entryPoint?: string;
	resourcesPath?: string;
	bundle?: {
		kind: "folder" | "zip" | "example";
		root: string;
		archives: string[];
		missing: string[];
		importedFiles: number;
	};
}
export function applicationPath(app: InstalledApp): string {
	return app.appPath || "/app";
}
export function applicationEntry(app: InstalledApp): string {
	return app.entryPoint || `${applicationPath(app)}/${app.manifest.main}`;
}
export type Support = "implemented" | "partial" | "unsupported";
export interface Capability {
	api: string;
	status: Support;
	notes: string;
}
export interface Finding extends Capability {
	file: string;
	line?: number;
}
export interface WindowOptions {
	autoHideMenuBar?: boolean;
	title?: string;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	show?: boolean;
	frame?: boolean;
	resizable?: boolean;
	backgroundColor?: string;
	webPreferences?: {
		userAgent?: string;
		preload?: string;
		sessionPreloads?: string[];
		nodeIntegration?: boolean;
		contextIsolation?: boolean;
		partition?: string;
		webviewTag?: boolean;
		additionalArguments?: string[];
	};
}
export interface LogEntry {
	time: number;
	level: "info" | "warn" | "error" | "debug";
	source: string;
	message: string;
}
export interface RuntimeConfig {
	instanceId: string;
	app: InstalledApp;
	snapshot: Snapshot;
	wisp: string;
	strict?: boolean;
	platform?: "linux" | "win32" | "darwin";
}
export interface RuntimeSettings {
	wisp: string;
	strict?: boolean;
	offline?: boolean;
	showAppMenu?: boolean;
	platform?: "linux" | "win32" | "darwin";
}
export interface RendererConfig extends RuntimeConfig {
	windowId: number;
	options: WindowOptions;
	filename: string;
}
export interface RpcMessage {
	type: "rpc";
	id: number;
	method: string;
	args: unknown[];
}
export interface RpcResult {
	type: "result";
	id: number;
	value?: unknown;
	error?: string;
}
export interface RuntimeBridge {
	syncXHR(request: { url: string }): void;
	config(windowId: number, filename: string): RendererConfig;
	send(windowId: number, message: unknown): void;
	subscribe(windowId: number, listener: (message: Record<string, unknown>) => void): () => void;
	proxyURL(url: string): string;
}
export const APP_ROOT = "/app";
// Bump when the shell and service worker can no longer use the same RPC contract.
export const HOST_WORKER_PROTOCOL = 2;
export function errorText(error: unknown): string {
	return error instanceof Error ? error.stack || error.message : String(error);
}
