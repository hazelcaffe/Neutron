/** Only application-defined schemes can be delivered as local desktop links. */
export function appLinkScheme(value: string): string | undefined {
	const scheme = value.toLowerCase().replace(/:$/, "");
	if (
		!/^[a-z][a-z0-9+.-]*$/.test(scheme) ||
		/^(?:https?|wss?|file|data|blob|javascript|about|mailto|tel|ftp|filesystem|view-source|devtools|chrome(?:-.*)?|resource|neutron)$/.test(
			scheme,
		)
	)
		return;
	return scheme;
}

// Scramjet puts its own flags in the outer query, and the document fragment
// can remain outside the encoded URL. Never treat a different session as ours.
export function browserTarget(value: string, prefix: URL): URL | undefined {
	try {
		const actual = new URL(value, prefix.origin);
		if (actual.origin !== prefix.origin || !actual.pathname.startsWith(prefix.pathname)) return;
		const target = new URL(decodeURIComponent(actual.pathname.slice(prefix.pathname.length)));
		if (actual.hash) target.hash = actual.hash;
		return target;
	} catch {
		return;
	}
}
