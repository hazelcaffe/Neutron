import { Buffer } from "buffer";
import { EventEmitter } from "events";

let strict = false;
const reported = new Set<string>();
const stubs = new WeakSet<object>();
const guarded = new WeakMap<object, object>();

export function configureCompatibility(value = false): void {
	strict = value;
	reported.clear();
}
export function isStrictCompatibility(): boolean {
	return strict;
}
export function noteStub(api: string): void {
	if (strict) throw new Error(`ERR_UNSUPPORTED_API: ${api} is not implemented by Neutron.`);
	if (!reported.has(api)) {
		reported.add(api);
		console.warn(`[compat] ${api}: using a fallback; no native operation was performed.`);
	}
}
export function isStub(value: unknown): boolean {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		stubs.has(value as object)
	);
}
/** Missing scalar properties must not turn an otherwise valid IPC payload into
 * an uncloneable function. Real application functions still fail structured clone. */
export function serializeFallbacks(
	value: unknown,
	label = "IPC",
	seen = new Map<object, unknown>(),
): unknown {
	if (isStub(value)) {
		noteStub(`${label} (unavailable value serialized as null)`);
		return null;
	}
	if (
		!value ||
		typeof value !== "object" ||
		ArrayBuffer.isView(value) ||
		value instanceof ArrayBuffer ||
		value instanceof Date ||
		value instanceof Error
	)
		return value;
	if (seen.has(value)) return seen.get(value);
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		value.forEach((item, index) => {
			result.push(serializeFallbacks(item, `${label}[${index}]`, seen));
		});
		return result;
	}
	if (value instanceof Map) {
		const result = new Map();
		seen.set(value, result);
		for (const [key, item] of value)
			result.set(serializeFallbacks(key, label, seen), serializeFallbacks(item, label, seen));
		return result;
	}
	if (value instanceof Set) {
		const result = new Set();
		seen.set(value, result);
		for (const item of value) result.add(serializeFallbacks(item, label, seen));
		return result;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
		return value;
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, item] of Object.entries(value))
		Object.defineProperty(result, key, {
			value: serializeFallbacks(item, `${label}.${key}`, seen),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	return result;
}

function resultFor(api: string): unknown {
	const name = api.split(".").at(-1) || api;
	if (name === "check_for_crash_reports") return false;
	if (name === "getCurrentKeyboardLayout") return null;
	if (name === "getKeyMap") return {};
	if (/^(isDestroyed|isCrashed|isLoading|isDevToolsOpened|hasSingleInstanceLock)$/.test(name))
		return false;
	if (/^(is|has|can|supports|register|enable|disable)/.test(name)) return true;
	if (
		/^(getAll|list|enumerate|enum)|^readValues$|Sources$|Printers|Products|Reports|Languages|Extensions/.test(
			name,
		)
	)
		return [];
	if (/Native(WindowHandle|View)|^serialize|^encrypt|^readBuffer/.test(name))
		return Buffer.alloc(0);
	if (/Bounds|Rectangle/.test(name)) return { x: 0, y: 0, width: 0, height: 0 };
	if (/^(getSize|getContentSize|getPosition|getMinimumSize|getMaximumSize)$/.test(name))
		return [0, 0];
	if (/Count$|Id$|ID$|Time$|Level$|Usage$|Size$/.test(name)) return 0;
	if (/Factor$|Opacity$/.test(name)) return 1;
	if (
		/Path$|Dir$|Directory$|_path$|_dir$|URL$|Title$|Name$|Version$|^readText|^decryptString/.test(
			name,
		)
	)
		return "";
	if (/^(get|read|query|resolve|check)/.test(name)) return {};
	if (
		/^(set|add|remove|unregister|clear|start|stop|close|destroy|attach|detach|write|flush|show|hide|quit|crash|hang|relaunch)/.test(
			name,
		)
	)
		return undefined;
	return createStub(`${api}()`);
}
const promiseNames =
	/Async$|^(setAutostart|checkForUpdates|downloadUpdate|getSources|getFileIcon|getPrinters|getPrintersAsync|capturePage|printToPDF|loadExtension|clearCache|clearStorageData|openExternal|trashItem|resolveProxy|sendCommand|purchaseProduct|getProducts|registerForAPNs)$/;

/** Callable + constructible + EventEmitter-compatible. Never a thenable. */
export function createStub(api: string): object {
	const emitter = new EventEmitter();
	const members = new Map<PropertyKey, unknown>();
	// A function declaration is intentional: Proxy construct traps require a constructible target.
	function StubTarget() {}
	const invoke = (args: unknown[]): unknown => {
		noteStub(api);
		const value = resultFor(api);
		const name = api.split(".").at(-1) || api;
		const callback = args.at(-1);
		if (
			typeof callback === "function" &&
			!/^(set|on|once|addListener|register|intercept|prepend)/.test(name)
		)
			queueMicrotask(() => callback(null, isStub(value) ? {} : value));
		return promiseNames.test(name) ? Promise.resolve(isStub(value) ? {} : value) : value;
	};
	const proxy = new Proxy(StubTarget, {
		apply: (_target, _this, args) => invoke(args),
		construct: (_target, args) => {
			noteStub(`new ${api}`);
			const object = createStub(`${api} instance`);
			Object.assign(object, typeof args[0] === "object" && args[0] !== null ? args[0] : {});
			return object;
		},
		get: (object, key) => {
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (
				descriptor &&
				!descriptor.configurable &&
				"value" in descriptor &&
				!descriptor.writable
			)
				return descriptor.value;
			if (key === "then" || key === "__esModule") return undefined;
			if (key === "name") return "";
			if (key === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 0 : "");
			if (key === Symbol.iterator) return function* () {};
			if (typeof key === "symbol" && !Reflect.has(object, key)) return undefined;
			if (key === "toJSON") return () => ({});
			if (key === "toString") return () => "";
			if (key === "default") return proxy;
			if (key === "prototype") return object.prototype;
			if (key === "length") return 0;
			if (
				key === "on" ||
				key === "once" ||
				key === "addListener" ||
				key === "prependListener" ||
				key === "removeListener" ||
				key === "off" ||
				key === "removeAllListeners"
			)
				return (...args: unknown[]) => {
					Reflect.apply(Reflect.get(emitter, key), emitter, args);
					return proxy;
				};
			if (
				key === "emit" ||
				key === "listenerCount" ||
				key === "listeners" ||
				key === "eventNames"
			)
				return Reflect.get(emitter, key).bind(emitter);
			if (Reflect.has(object, key) && !["name", "caller", "arguments"].includes(String(key)))
				return Reflect.get(object, key);
			if (!members.has(key))
				members.set(
					key,
					typeof key === "string" && /^[A-Z][A-Z\d_]+$/.test(key)
						? 0
						: createStub(`${api}.${String(key)}`),
				);
			return members.get(key);
		},
		set: (object, key, value) => Reflect.set(object, key, value),
	});
	stubs.add(proxy);
	return proxy;
}

/** Existing implementations retain their errors; only absent members get fallbacks. */
export function withFallback<T extends object>(target: T, api: string): T {
	if (isStub(target)) return target;
	const cached = guarded.get(target);
	if (cached) return cached as T;
	const methods = new Map<PropertyKey, unknown>();
	const proxy = new Proxy(target, {
		set: (object, key, value) => {
			methods.delete(key);
			return Reflect.set(object, key, value, object);
		},
		defineProperty: (object, key, descriptor) => {
			methods.delete(key);
			return Reflect.defineProperty(object, key, descriptor);
		},
		get: (object, key) => {
			if (!Reflect.has(object, key)) {
				if (key === "then" || key === "__esModule" || typeof key === "symbol")
					return undefined;
				if (!methods.has(key)) methods.set(key, createStub(`${api}.${String(key)}`));
				return methods.get(key);
			}
			const value: unknown = Reflect.get(object, key, object);
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (
				descriptor &&
				!descriptor.configurable &&
				"value" in descriptor &&
				!descriptor.writable
			)
				return value;
			if (key === "prototype" || key === "constructor") return value;
			if (typeof value === "function") {
				if (isStub(value)) return value;
				if (!methods.has(key))
					methods.set(
						key,
						new Proxy(value, {
							apply: (fn, _this, args) => {
								const result = Reflect.apply(fn, object, args);
								return result === object
									? proxy
									: result instanceof EventEmitter
										? withFallback(result, `${api}.${String(key)}`)
										: result;
							},
							construct: (fn, args, newTarget) =>
								withFallback(
									Reflect.construct(fn, args, newTarget),
									`${api}.${String(key)}`,
								),
							get: (fn, property) =>
								Reflect.has(fn, property)
									? Reflect.get(fn, property)
									: property === "then" || typeof property === "symbol"
										? undefined
										: createStub(`${api}.${String(key)}.${String(property)}`),
						}),
					);
				return methods.get(key);
			}
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				!ArrayBuffer.isView(value) &&
				!(value instanceof Promise) &&
				!(value instanceof EventTarget) &&
				!(value instanceof ArrayBuffer) &&
				!(value instanceof Date)
			)
				// Data dictionaries must retain ordinary absent-property semantics. A
				// fabricated truthy process.env.XDG_RUNTIME_DIR breaks path fallbacks.
				return !["env", "versions", "options", "webPreferences", "mainModule"].includes(
					String(key),
				) &&
					(value instanceof EventEmitter ||
						Object.values(Object.getOwnPropertyDescriptors(value)).some(
							(descriptor) => typeof descriptor.value === "function",
						))
					? withFallback(value, `${api}.${String(key)}`)
					: value;
			return value;
		},
	});
	guarded.set(target, proxy);
	guarded.set(proxy, proxy);
	return proxy;
}
export function unsupported<T = never>(api: string): T {
	noteStub(api);
	return resultFor(api) as T;
}
