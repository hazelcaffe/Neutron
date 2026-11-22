import { Buffer } from "buffer";
import browserCrypto from "crypto-browserify";
import { EventEmitter } from "events";
import { noteStub } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";
import type { RpcClient } from "./rpc";

const crypto = browserCrypto as unknown as typeof import("node:crypto");
export function platformModules(
	vfs: VirtualFileSystem,
	rpc: RpcClient,
	appName: string,
	send: (message: unknown) => void,
) {
	const keyPath = `/home/user/.config/${appName}/.neutron-storage-key`;
	const key = (): Buffer => {
		if (!vfs.fs.existsSync(keyPath)) vfs.fs.writeFileSync(keyPath, crypto.randomBytes(32));
		return Buffer.from(vfs.fs.readFileSync(keyPath) as Uint8Array);
	};
	const safeStorage = {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "browser-opfs",
		encryptString: (value: string) => {
			const iv = crypto.randomBytes(12);
			const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
			const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([Buffer.from("NTR1"), iv, cipher.getAuthTag(), encrypted]);
		},
		decryptString: (data: Uint8Array) => {
			const buffer = Buffer.from(data);
			if (buffer.toString("ascii", 0, 4) !== "NTR1")
				throw new Error(
					"Unsupported safeStorage ciphertext (native OS ciphertext cannot be decrypted here)",
				);
			const cipher = crypto.createDecipheriv("aes-256-gcm", key(), buffer.subarray(4, 16));
			cipher.setAuthTag(buffer.subarray(16, 32));
			return Buffer.concat([cipher.update(buffer.subarray(32)), cipher.final()]).toString(
				"utf8",
			);
		},
	};
	let themeSource = "system";
	let systemDark = false;
	const nativeTheme = Object.assign(new EventEmitter(), {
		shouldUseHighContrastColors: false,
		shouldUseInvertedColorScheme: false,
	});
	Object.defineProperties(nativeTheme, {
		themeSource: {
			get: () => themeSource,
			set: (value: string) => {
				if (typeof value !== "string") {
					noteStub("nativeTheme.themeSource (missing native settings; using system)");
					value = "system";
				}
				if (!["system", "dark", "light"].includes(value))
					throw new Error("Invalid themeSource");
				themeSource = value;
				nativeTheme.emit("updated");
			},
		},
		shouldUseDarkColors: {
			get: () => themeSource === "dark" || (themeSource === "system" && systemDark),
		},
		shouldUseDarkColorsForSystemIntegratedUI: {
			get: () => themeSource === "dark" || (themeSource === "system" && systemDark),
		},
	});
	let nextWake = 0;
	const wakes = new Set<number>();
	const powerSaveBlocker = {
		start: (type: string) => {
			const id = ++nextWake;
			wakes.add(id);
			void rpc.call("platform.wake", true, type).catch((error: unknown) => {
				wakes.delete(id);
				console.warn(error);
			});
			return id;
		},
		stop: (id: number) => {
			wakes.delete(id);
			if (!wakes.size) void rpc.call("platform.wake", false);
		},
		isStarted: (id: number) => wakes.has(id),
	};
	const preferences: Record<string, unknown> = {};
	let reducedMotion = false;
	const systemPreferences = Object.assign(new EventEmitter(), {
		getAccentColor: () => "b8d6a3ff",
		getColor: () => "#b8d6a3",
		getSystemColor: () => "#b8d6a3",
		isDarkMode: () => Reflect.get(nativeTheme, "shouldUseDarkColors"),
		getEffectiveAppearance: () =>
			Reflect.get(nativeTheme, "shouldUseDarkColors") ? "dark" : "light",
		getAnimationSettings: () => ({
			shouldRenderRichAnimation: !reducedMotion,
			scrollAnimationsEnabledBySystem: !reducedMotion,
			prefersReducedMotion: reducedMotion,
		}),
		getUserDefault: (key: string) => preferences[key],
		setUserDefault: (key: string, _type: string, value: unknown) => {
			preferences[key] = value;
		},
		registerDefaults: (values: object) => Object.assign(preferences, values),
		getMediaAccessStatus: () => "not-determined",
		askForMediaAccess: (media: string) => rpc.call<boolean>("platform.media", media),
	});
	const parameters: Record<string, string> = {};
	let uploadToServer = false;
	const crashReporter = {
		start: (options: { extra?: Record<string, string>; uploadToServer?: boolean } = {}) => {
			Object.assign(parameters, options.extra);
			uploadToServer = options.uploadToServer === true;
		},
		getParameters: () => ({ ...parameters }),
		addExtraParameter: (key: string, value: string) => {
			parameters[key] = value;
		},
		removeExtraParameter: (key: string) => {
			delete parameters[key];
		},
		getUploadToServer: () => uploadToServer,
		setUploadToServer: (value: boolean) => {
			uploadToServer = value;
		},
		getUploadedReports: async () => [],
		getLastCrashReport: () => null,
	};
	let recording = false;
	let started = 0;
	const contentTracing = {
		getCategories: async () => ["neutron", "blink.user_timing"],
		startRecording: async () => {
			recording = true;
			started = performance.now();
		},
		stopRecording: async (filename = "/tmp/neutron-trace.json") => {
			vfs.fs.writeFileSync(
				filename,
				JSON.stringify({
					traceEvents: performance
						.getEntries()
						.filter((entry) => entry.startTime >= started)
						.map((entry) => ({
							name: entry.name,
							cat: "blink.user_timing",
							ph: "X",
							ts: entry.startTime * 1000,
							dur: entry.duration * 1000,
							pid: 1,
							tid: 1,
						})),
				}),
			);
			recording = false;
			return filename;
		},
		getTraceBufferUsage: async () => ({
			value: recording ? performance.getEntries().length / 10000 : 0,
			percentage: 0,
		}),
	};
	class Tray extends EventEmitter {
		private destroyed = false;
		private title = "";
		private tooltip = "";
		private menu?: { popup(): void };
		constructor(_image?: unknown) {
			super();
		}
		setImage(_image: unknown): void {
			/* Virtual tray uses a text label. */
		}
		setTitle(value: string): void {
			this.title = value;
			send({ type: "tray", title: value, tooltip: this.tooltip });
		}
		getTitle(): string {
			return this.title;
		}
		setToolTip(value: string): void {
			this.tooltip = value;
			send({ type: "tray", title: this.title, tooltip: value });
		}
		setContextMenu(menu: { popup(): void }): void {
			this.menu = menu;
		}
		popUpContextMenu(): void {
			this.menu?.popup();
		}
		destroy(): void {
			this.destroyed = true;
			send({ type: "tray", title: "", tooltip: "" });
		}
		isDestroyed(): boolean {
			return this.destroyed;
		}
		getBounds(): object {
			return { x: 0, y: 0, width: 24, height: 24 };
		}
	}
	const powerMonitor = Object.assign(new EventEmitter(), {
		getSystemIdleTime: () => Math.floor((Date.now() - lastActivity) / 1000),
		getSystemIdleState: (threshold: number) =>
			(Date.now() - lastActivity) / 1000 >= threshold ? "idle" : "active",
		isOnBatteryPower: () => battery,
		getCurrentThermalState: () => "unknown",
	});
	let lastActivity = Date.now();
	let battery = false;
	return {
		safeStorage,
		nativeTheme,
		powerSaveBlocker,
		systemPreferences,
		crashReporter,
		contentTracing,
		Tray,
		powerMonitor,
		receive: (message: Record<string, unknown>) => {
			if (message.type === "theme") {
				systemDark = Boolean(message.dark);
				reducedMotion = message.reducedMotion === true;
				nativeTheme.emit("updated");
			}
			if (message.type === "activity") lastActivity = Date.now();
			if (message.type === "power") {
				battery = Boolean(message.battery);
				powerMonitor.emit(battery ? "on-battery" : "on-ac");
			}
		},
	};
}
