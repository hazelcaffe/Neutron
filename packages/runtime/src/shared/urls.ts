import { protocolPrefix } from "./base";

/** Preserve the URL's directory structure so native relative script/CSS/module loads work. */
export function protocolURL(instanceId: string, value: string | URL): string {
	const url = new URL(value);
	if (!url.host) return `${protocolPrefix()}${instanceId}/_/${encodeURIComponent(url.href)}`;
	const authority = `${url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : ""}${url.host}`;
	return `${protocolPrefix()}${instanceId}/${url.protocol.slice(0, -1)}/${encodeURIComponent(authority)}${url.pathname || "/"}${url.search}${url.hash}`;
}
export function parseProtocolURL(value: string | URL): { instanceId: string; url: string } {
	const local = new URL(value);
	if (!local.pathname.startsWith(protocolPrefix())) throw new Error("Not a virtual protocol URL");
	const [instanceId, scheme, authority, ...parts] = local.pathname
		.slice(protocolPrefix().length)
		.split("/");
	if (!instanceId || !scheme) throw new Error("Incomplete virtual protocol URL");
	if (scheme === "_") return { instanceId, url: decodeURIComponent(authority || "") };
	// Support already-open pages using the original single encoded-URL layout.
	if (scheme.includes("%"))
		return {
			instanceId,
			url:
				decodeURIComponent(
					[scheme, authority, ...parts].filter((part) => part !== undefined).join("/"),
				) +
				local.search +
				local.hash,
		};
	if (!/^[a-z][a-z\d+.-]*$/i.test(scheme) || !authority)
		throw new Error("Invalid virtual protocol URL");
	return {
		instanceId,
		url: `${scheme}://${decodeURIComponent(authority)}/${parts.join("/")}${local.search}${local.hash}`,
	};
}
