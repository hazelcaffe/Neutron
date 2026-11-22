/** Electron copies bridge data; freezing an app's original object breaks its
 * subsequent initialization. Functions retain their callable identity here. */
export function bridgeValue(value: unknown, seen = new Map<object, unknown>()): unknown {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value);
	if (ArrayBuffer.isView(value)) return structuredClone(value);
	if (value instanceof ArrayBuffer || value instanceof Date || value instanceof Error)
		return structuredClone(value);
	const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
	seen.set(value, copy);
	for (const [key, item] of Object.entries(value))
		Object.defineProperty(copy, key, {
			value: bridgeValue(item, seen),
			enumerable: true,
			configurable: true,
			writable: true,
		});
	return Object.freeze(copy);
}

/** Separate preload-owned global properties from page exports. This emulates
 * the common bridge contract, not a separate Chromium realm/security boundary. */
export function preloadWindow(target: Window & typeof globalThis): Window & typeof globalThis {
	const native = new Set(Reflect.ownKeys(target));
	const local: Record<PropertyKey, unknown> = Object.create(null);
	const methods = new Map<PropertyKey, unknown>();
	const bound = new Set([
		"addEventListener",
		"removeEventListener",
		"dispatchEvent",
		"postMessage",
		"getComputedStyle",
		"matchMedia",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"requestIdleCallback",
		"cancelIdleCallback",
		"fetch",
		"setTimeout",
		"clearTimeout",
		"setInterval",
		"clearInterval",
	]);
	const proxy = new Proxy(local, {
		get(object, key) {
			if (["window", "self", "globalThis", "global"].includes(String(key))) return proxy;
			if (Object.hasOwn(object, key)) return Reflect.get(object, key);
			if (!native.has(key) && !(key in Window.prototype)) return undefined;
			if (key === "postMessage" && target.__neutronProxyClient) {
				if (!methods.has(key))
					methods.set(key, (...args: unknown[]) =>
						target.__neutronProxyClient?.natives.call(
							"window.postMessage",
							target,
							...args,
						),
					);
				return methods.get(key);
			}
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function" || !bound.has(String(key))) return value;
			if (!methods.has(key)) methods.set(key, value.bind(target));
			return methods.get(key);
		},
		has: (object, key) => Object.hasOwn(object, key) || native.has(key),
	});
	return proxy as unknown as Window & typeof globalThis;
}
