import { parseArgs } from "@pkgjs/parseargs";
import assert from "assert/";
import zlib from "browserify-zlib";
import crypto from "crypto-browserify";
import { EventEmitter } from "events";
import path from "path-browserify";
import win32 from "path-win32";
import * as punycode from "punycode/";
import querystring from "querystring-es3";
import * as stream from "readable-stream";
import { StringDecoder } from "string_decoder/";
import stripAnsi from "strip-ansi";
import * as url from "url/";
import * as util from "util/";
import { applicationEntry, applicationPath, type RuntimeConfig } from "../shared/types";
import { brotli, brotliConstants } from "./brotli";
import { bufferModule } from "./buffer";
import { asyncHooks, diagnostics, domains } from "./context";
import { dnsModule } from "./dns";
import { eventsModule } from "./events";
import { createStub, noteStub, withFallback } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";
import type { Network } from "./network";
import { fileURLModule } from "./node-url";
import { v8Module, vmModule } from "./optional";
import { isProxy } from "./proxies";
import { readlineModules } from "./readline";
import { sqliteModules } from "./sqlite";
import { consumers, installWebStreamAdapters, streamPromises, webStreams } from "./streams";
import { nodeTimers, timerPromises } from "./timers";
import { chromeVersion, electronVersion, runtimeArch } from "./user-agent";
import { zstd, zstdConstants } from "./zstd";

export { unsupported } from "./fallback";

import { unsupported } from "./fallback";

export function unsupportedModule(name: string): object {
	return createStub(name);
}
export function makeProcess(
	config: RuntimeConfig,
	type: "browser" | "renderer" | "utility" | undefined,
	exit: (code: number) => void,
) {
	const start = performance.now();
	const platform = config.platform || "linux";
	let cwd = applicationPath(config.app);
	let mask = 0o022;
	const emitter = new EventEmitter();
	const hidden = new WeakMap<object, Map<string, unknown>>();
	const v8Util = {
		getHiddenValue: (object: object, name: string) => hidden.get(object)?.get(name),
		setHiddenValue: (object: object, name: string, value: unknown) => {
			let fields = hidden.get(object);
			if (!fields) {
				fields = new Map();
				hidden.set(object, fields);
			}
			fields.set(name, value);
		},
		deleteHiddenValue: (object: object, name: string) => hidden.get(object)?.delete(name),
	};
	const output = (level: "log" | "error") =>
		Object.assign(
			new stream.Writable({
				write(chunk, _encoding, done) {
					console[level](String(chunk));
					done();
				},
			}),
			{ isTTY: false, fd: level === "log" ? 1 : 2 },
		);
	const hrtime = Object.assign(
		(previous?: [number, number]) => {
			let time = (performance.now() - start) / 1000;
			if (previous) time -= previous[0] + previous[1] / 1e9;
			const seconds = Math.floor(time);
			return [seconds, Math.floor((time - seconds) * 1e9)];
		},
		{ bigint: () => BigInt(Math.floor((performance.now() - start) * 1e6)) },
	);
	return withFallback(
		Object.assign(emitter, {
			type,
			platform,
			arch: runtimeArch,
			browser: true,
			sandboxed: false,
			contextIsolated: false,
			version: "v22.0.0",
			versions: {
				node: "22.0.0",
				napi: "10",
				modules: "130",
				uv: "1.49.2",
				v8: "12.8.0",
				electron: electronVersion,
				chrome: chromeVersion,
				neutron: "0.1.0",
			},
			env: {
				NODE_ENV: "production",
				HOME: "/home/user",
				TMPDIR: "/tmp",
				USER: "user",
				PATH: "/usr/bin",
				USERPROFILE: "/home/user",
				APPDATA: "/home/user/AppData/Roaming",
				LOCALAPPDATA: "/home/user/AppData/Local",
				TEMP: "/tmp",
				LANG: `${navigator.language.replaceAll("-", "_")}.UTF-8`,
				LC_ALL: `${navigator.language.replaceAll("-", "_")}.UTF-8`,
			},
			// Packaged Electron does not pass the main script as a document to open.
			argv:
				type === "browser"
					? ["/neutron/electron", ...(config.argv ?? [])]
					: ["/neutron/electron", applicationEntry(config.app)],
			argv0: "/neutron/electron",
			contextId: `${type === "browser" ? 1 : 2}-${globalThis.crypto.randomUUID()}`,
			mainModule: undefined,
			mas: false,
			windowsStore: false,
			defaultApp: false,
			execPath: "/neutron/electron",
			resourcesPath:
				platform === "win32"
					? win32.normalize(config.app.resourcesPath || "/")
					: config.app.resourcesPath || "/",
			pid: type === "browser" ? 1 : 2,
			ppid: 0,
			execArgv: [],
			getuid: () => 1000,
			geteuid: () => 1000,
			getgid: () => 1000,
			getegid: () => 1000,
			getgroups: () => [1000],
			umask: (value?: number) => {
				const previous = mask;
				if (value !== undefined) mask = value;
				return previous;
			},
			cwd: () => cwd,
			chdir: (value: string) => {
				cwd = path.resolve(cwd, value);
			},
			nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
				queueMicrotask(() => callback(...args)),
			uptime: () => (performance.now() - start) / 1000,
			hrtime,
			exit: (code = 0) => {
				emitter.emit("exit", code);
				exit(code);
			},
			getSystemVersion: () => "browser",
			getCreationTime: () => performance.timeOrigin,
			memoryUsage: () => ({
				rss: 0,
				heapTotal: 0,
				heapUsed: 0,
				external: 0,
				arrayBuffers: 0,
			}),
			availableMemory: () =>
				(Number(Reflect.get(navigator, "deviceMemory")) || 4) * 1024 ** 3,
			emitWarning: (warning: unknown) => console.warn(warning),
			stdout: output("log"),
			stderr: output("error"),
			stdin: Object.assign(new stream.PassThrough(), {
				isTTY: false,
				fd: 0,
				setRawMode: () => undefined,
			}),
			_linkedBinding: (name: string) =>
				name === "electron_common_v8_util"
					? v8Util
					: unsupported(`process._linkedBinding(${name})`),
			binding: (name: string) =>
				name === "util" ? util.types : unsupported(`process.binding(${name})`),
			dlopen: (module: { exports: unknown }, filename: string) => {
				noteStub(`process.dlopen(${filename})`);
				module.exports = createStub(filename);
			},
		}),
		"process",
	);
}
export function makeBuiltins(
	vfs: VirtualFileSystem,
	network: Network,
	electron: object,
	process: ReturnType<typeof makeProcess>,
): Record<string, unknown> {
	const chdir = process.chdir;
	process.chdir = (value: string) => {
		const resolved = path.resolve(vfs.cwd, vfs.normalizePath(value));
		if (!vfs.fs.statSync(resolved).isDirectory()) throw new Error(`ENOTDIR: ${value}`);
		chdir(resolved);
		vfs.cwd = resolved;
	};
	const virtualPosix = {
		...path,
		resolve: (...values: string[]) => path.resolve(vfs.cwd, ...values),
	};
	const virtualWindows = {
		...win32,
		resolve: (...values: string[]) => win32.resolve(vfs.cwd, ...values),
	};
	for (const value of [virtualPosix, virtualWindows])
		Object.defineProperties(value, {
			posix: { value: virtualPosix, enumerable: true },
			win32: { value: virtualWindows, enumerable: true },
		});
	const virtualPath = process.platform === "win32" ? virtualWindows : virtualPosix;
	installWebStreamAdapters();
	const dns = dnsModule(network);
	const sqlite = sqliteModules(vfs);
	let reportSequence = 0;
	// Diagnostic reports describe the virtual process and its target ABI, not
	// the browser host. Linux uses the Debian 12 profile exposed in os-release.
	const report = {
		directory: "",
		filename: "",
		compact: false,
		excludeEnv: false,
		getReport(error = new Error("JavaScript API")) {
			const now = new Date();
			return {
				header: {
					reportVersion: 5,
					event: "JavaScript API",
					trigger: "GetReport",
					filename: null,
					dumpEventTime: now.toISOString(),
					dumpEventTimeStamp: String(now.getTime()),
					processId: process.pid,
					cwd: process.cwd(),
					commandLine: [...process.argv],
					nodejsVersion: process.version,
					componentVersions: { ...process.versions },
					platform: process.platform,
					arch: process.arch,
					host: "neutron",
					...(process.platform === "linux"
						? { glibcVersionRuntime: "2.36", glibcVersionCompiler: "2.36" }
						: {}),
				},
				javascriptStack: {
					message: error.toString(),
					stack: (error.stack || "").split("\n").slice(1),
				},
				nativeStack: [],
				libuv: [],
				workers: [],
				sharedObjects: [],
				...(report.excludeEnv ? {} : { environmentVariables: { ...process.env } }),
			};
		},
		writeReport(filename?: string | Error, error?: Error) {
			const name =
				typeof filename === "string" && filename
					? filename
					: report.filename ||
						`report.${Date.now()}.${process.pid}.${++reportSequence}.json`;
			const target = path.resolve(vfs.cwd, report.directory, name);
			const data = report.getReport(filename instanceof Error ? filename : error);
			vfs.fs.writeFileSync(
				target,
				JSON.stringify(
					{
						...data,
						header: { ...data.header, filename: target, trigger: "WriteReport" },
					},
					null,
					report.compact ? undefined : 2,
				),
			);
			return target;
		},
	};
	Object.assign(process, { report });
	const readline = readlineModules();
	if (process.platform === "linux" && !vfs.fs.existsSync("/etc/os-release")) {
		vfs.fs.mkdirSync("/etc", { recursive: true });
		vfs.fs.writeFileSync(
			"/etc/os-release",
			'NAME="Neutron"\nPRETTY_NAME="Neutron browser Linux compatibility"\nID=debian\nID_LIKE=debian\nVERSION_ID="12"\n',
		);
	}
	const os = {
		constants: {
			signals: {
				...Object.fromEntries(
					[
						"",
						"SIGHUP",
						"SIGINT",
						"SIGQUIT",
						"SIGILL",
						"SIGTRAP",
						"SIGABRT",
						"SIGBUS",
						"SIGFPE",
						"SIGKILL",
						"SIGUSR1",
						"SIGSEGV",
						"SIGUSR2",
						"SIGPIPE",
						"SIGALRM",
						"SIGTERM",
						"SIGSTKFLT",
						"SIGCHLD",
						"SIGCONT",
						"SIGSTOP",
						"SIGTSTP",
						"SIGTTIN",
						"SIGTTOU",
						"SIGURG",
						"SIGXCPU",
						"SIGXFSZ",
						"SIGVTALRM",
						"SIGPROF",
						"SIGWINCH",
						"SIGIO",
						"SIGPWR",
						"SIGSYS",
					]
						.slice(1)
						.map((name, index) => [name, index + 1]),
				),
				SIGIOT: 6,
				SIGPOLL: 29,
			},
			priority: {
				PRIORITY_LOW: 19,
				PRIORITY_BELOW_NORMAL: 10,
				PRIORITY_NORMAL: 0,
				PRIORITY_ABOVE_NORMAL: -7,
				PRIORITY_HIGH: -14,
				PRIORITY_HIGHEST: -20,
			},
		},
		platform: () => process.platform,
		arch: () => process.arch,
		type: () =>
			process.platform === "win32"
				? "Windows_NT"
				: process.platform === "darwin"
					? "Darwin"
					: "Linux",
		version: () => navigator.userAgent,
		uptime: () => performance.now() / 1000,
		availableParallelism: () => navigator.hardwareConcurrency || 1,
		totalmem: () => (Number(Reflect.get(navigator, "deviceMemory")) || 4) * 1024 ** 3,
		freemem: () => (Number(Reflect.get(navigator, "deviceMemory")) || 4) * 1024 ** 3,
		loadavg: () => [0, 0, 0],
		machine: () => (process.arch === "arm64" ? "aarch64" : "x86_64"),
		release: () => "1.0",
		homedir: () => "/home/user",
		tmpdir: () => "/tmp",
		hostname: () => "neutron",
		EOL: process.platform === "win32" ? "\r\n" : "\n",
		cpus: () =>
			Array.from({ length: navigator.hardwareConcurrency || 1 }, () => ({
				model: "Browser virtual CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			})),
		userInfo: () => ({
			username: "user",
			homedir: "/home/user",
			shell: null,
			uid: 1000,
			gid: 1000,
		}),
		endianness: () => "LE",
		networkInterfaces: () => ({}),
	};
	return {
		electron,
		"better-sqlite3": sqlite.better,
		sqlite3: sqlite.sqlite3,
		"@vscode/sqlite3": sqlite.sqlite3,
		"electron/main": electron,
		"electron/renderer": electron,
		"electron/common": electron,
		fs: vfs.fs,
		"original-fs": vfs.fs,
		"fs/promises": vfs.fs.promises,
		path: virtualPath,
		"path/posix": virtualPosix,
		"path/win32": virtualWindows,
		buffer: bufferModule(),
		events: eventsModule(),
		util: {
			...util,
			stripVTControlCharacters: (input: string) => {
				if (typeof input !== "string")
					throw Object.assign(new TypeError('The "str" argument must be a string'), {
						code: "ERR_INVALID_ARG_TYPE",
					});
				return stripAnsi(input);
			},
			types: { ...util.types, isProxy, isExternal: () => false },
			TextEncoder,
			TextDecoder,
			parseArgs,
			formatWithOptions: (_options: object, ...args: unknown[]) => util.format(...args),
		},
		"util/types": { ...util.types, isProxy, isExternal: () => false },
		async_hooks: asyncHooks,
		diagnostics_channel: diagnostics,
		domain: domains,
		console: Object.assign(console, {
			Console: class {
				constructor(
					options: {
						stdout?: { write(value: string): unknown };
						stderr?: { write(value: string): unknown };
					} = {},
				) {
					for (const name of ["log", "info", "debug", "warn", "error"] as const)
						Object.assign(this, {
							[name]: (...args: unknown[]) => {
								const output =
									name === "error" || name === "warn"
										? options.stderr
										: options.stdout;
								return output
									? output.write(`${util.format(...args)}\n`)
									: console[name](...args);
							},
						});
				}
			},
		}),
		url: { ...url, ...fileURLModule(process.platform, () => vfs.cwd) },
		assert,
		"assert/strict": assert.strict,
		stream: Object.defineProperty(Object.assign(stream.Stream, stream), "promises", {
			value: streamPromises,
			configurable: true,
			writable: true,
		}),
		"stream/promises": streamPromises,
		"stream/consumers": consumers,
		"stream/web": webStreams(),
		"stream/duplex": stream.Duplex,
		"stream/readable": stream.Readable,
		"stream/writable": stream.Writable,
		"stream/transform": stream.Transform,
		"stream/passthrough": stream.PassThrough,
		string_decoder: { StringDecoder },
		querystring,
		punycode,
		os,
		process,
		starship: withFallback({ operatingSystemArchitecture: process.arch }, "starship"),
		crypto: withFallback(
			{
				...crypto,
				webcrypto: globalThis.crypto,
				subtle: globalThis.crypto.subtle,
				randomUUID: () => globalThis.crypto.randomUUID(),
			},
			"crypto",
		),
		zlib: {
			...zlib,
			...brotli,
			...zstd,
			constants: {
				...zstdConstants,
				...brotliConstants,
				...Object.fromEntries(
					Object.entries(zlib).filter(([name]) => /^Z_|^BROTLI_/.test(name)),
				),
			},
		},
		http: network.http(),
		https: network.http("https:"),
		net: network.sockets(),
		tls: network.tls(),
		dgram: network.datagrams(),
		ws: network.webSocketClass(),
		timers: { ...nodeTimers, promises: timerPromises },
		"timers/promises": timerPromises,
		perf_hooks: { performance, PerformanceObserver, PerformanceEntry },
		tty: withFallback({ isatty: () => false }, "tty"),
		constants: vfs.fs.constants,
		readline,
		"readline/promises": readline.promises,
		dns,
		"dns/promises": dns.promises,
		...Object.fromEntries(
			[
				"child_process",
				"worker_threads",
				"cluster",
				"inspector",
				"repl",
				"http2",
				"inspector/promises",
				"sqlite",
				"wasi",
				"trace_events",
			].map((name) => [name, unsupportedModule(name)]),
		),
		vm: withFallback(vmModule(), "vm"),
		v8: withFallback(v8Module, "v8"),
	};
}
