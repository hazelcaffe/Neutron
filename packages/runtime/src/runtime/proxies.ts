// V8 exposes isProxy; browsers do not. Track Proxy objects created through the
// Node module realm, including revocable proxies, without invoking their traps.
const proxies = new WeakSet<object>();
const NativeProxy = Proxy;
export const nodeProxy = new NativeProxy(NativeProxy, {
	construct(target, args: [object, ProxyHandler<object>]) {
		const proxy = new target(...args);
		proxies.add(proxy);
		return proxy;
	},
	get(target, key) {
		if (key === "revocable")
			return (object: object, handler: ProxyHandler<object>) => {
				const result = NativeProxy.revocable(object, handler);
				proxies.add(result.proxy);
				return result;
			};
		return Reflect.get(target, key);
	},
});
export const isProxy = (value: unknown): boolean =>
	((typeof value === "object" && value !== null) || typeof value === "function") &&
	proxies.has(value as object);
