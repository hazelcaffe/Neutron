import type { Network } from "./network";

const TYPES: Record<string, number> = {
	A: 1,
	NS: 2,
	CNAME: 5,
	SOA: 6,
	PTR: 12,
	MX: 15,
	TXT: 16,
	AAAA: 28,
	SRV: 33,
	CAA: 257,
};
type Answer = { name: string; type: number; TTL: number; data: string };
export function dnsModule(network: Network) {
	let order = "verbatim";
	const query = async (hostname: string, type: string): Promise<Answer[]> => {
		if (!hostname)
			throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
				code: "ENOTFOUND",
				hostname,
			});
		const response = await network.fetch(
			`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: hostname, type })}`,
			{ headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) },
		);
		if (!response.ok)
			throw Object.assign(new Error(`DNS query failed: HTTP ${response.status}`), {
				code: "EAI_AGAIN",
			});
		const result = (await response.json()) as { Status: number; Answer?: Answer[] };
		if (result.Status !== 0)
			throw Object.assign(new Error(`query${type} ENOTFOUND ${hostname}`), {
				code: "ENOTFOUND",
				hostname,
			});
		return (result.Answer || []).filter((answer) => answer.type === TYPES[type]);
	};
	const resolve = async (hostname: string, rrtype = "A"): Promise<unknown[]> => {
		const answers = await query(hostname, rrtype);
		return answers.map((answer) => {
			if (rrtype === "TXT")
				return [...answer.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
					(match) => match[1]?.replace(/\\"/g, '"') || "",
				);
			if (rrtype === "MX") {
				const [priority, ...exchange] = answer.data.split(" ");
				return {
					priority: Number(priority),
					exchange: exchange.join(" ").replace(/\.$/, ""),
				};
			}
			if (rrtype === "SRV") {
				const [priority, weight, port, ...name] = answer.data.split(" ");
				return {
					priority: Number(priority),
					weight: Number(weight),
					port: Number(port),
					name: name.join(" ").replace(/\.$/, ""),
				};
			}
			return answer.data.replace(/\.$/, "");
		});
	};
	const lookup = async (
		hostname: string,
		options:
			| number
			| { family?: number; all?: boolean; order?: string; verbatim?: boolean } = {},
	) => {
		if (typeof options === "number") options = { family: options };
		let addresses: { address: string; family: number }[] = [];
		if (hostname === "localhost")
			addresses = [
				{ address: "127.0.0.1", family: 4 },
				{ address: "::1", family: 6 },
			];
		else if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname))
			addresses = [{ address: hostname, family: 4 }];
		else if (hostname.includes(":")) addresses = [{ address: hostname, family: 6 }];
		else {
			const results = await Promise.allSettled([
				options.family === 6 ? Promise.resolve([]) : resolve(hostname, "A"),
				options.family === 4 ? Promise.resolve([]) : resolve(hostname, "AAAA"),
			]);
			results.forEach((result, index) => {
				if (result.status === "fulfilled")
					addresses.push(
						...result.value.map((address) => ({
							address: String(address),
							family: index ? 6 : 4,
						})),
					);
			});
		}
		if (options.family)
			addresses = addresses.filter((address) => address.family === options.family);
		if ((options.order || order) === "ipv6first") addresses.sort((a, b) => b.family - a.family);
		if (!addresses.length)
			throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
				code: "ENOTFOUND",
				hostname,
			});
		return options.all ? addresses : addresses[0];
	};
	const promises = {
		lookup,
		resolve,
		...Object.fromEntries(
			["4", "6", "Txt", "Mx", "Srv", "Ns", "Cname"].map((suffix) => [
				`resolve${suffix}`,
				(hostname: string) =>
					resolve(
						hostname,
						{
							"4": "A",
							"6": "AAAA",
							Txt: "TXT",
							Mx: "MX",
							Srv: "SRV",
							Ns: "NS",
							Cname: "CNAME",
						}[suffix] || suffix,
					),
			]),
		),
	};
	const callbacks = Object.fromEntries(
		Object.entries(promises).map(([name, method]) => [
			name,
			(...args: unknown[]) => {
				const callback = args.pop();
				if (typeof callback !== "function") throw new TypeError("DNS callback is required");
				Promise.resolve(Reflect.apply(method, promises, args)).then(
					(result) => {
						if (name === "lookup" && !Array.isArray(result)) {
							const address = result as { address: string; family: number };
							callback(null, address.address, address.family);
						} else callback(null, result);
					},
					(error) => callback(error),
				);
			},
		]),
	);
	class Resolver {
		constructor() {
			Object.assign(this, callbacks);
		}
	}
	class PromiseResolver {
		constructor() {
			Object.assign(this, promises);
		}
	}
	return {
		...callbacks,
		promises: { ...promises, Resolver: PromiseResolver },
		Resolver,
		ADDRCONFIG: 32,
		V4MAPPED: 8,
		ALL: 16,
		getDefaultResultOrder: () => order,
		setDefaultResultOrder: (value: string) => {
			order = value;
		},
		getServers: () => ["1.1.1.1"],
	};
}
