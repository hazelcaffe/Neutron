import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import type { FetchHandler, ScramjetAPI } from "../shared/proxy-context";

// The fetch handler works in rewritten (same-origin) URL space. Apply the
// browser's credentials mode to the *virtual* origins on both sides of its jar.
type CookieContext = {
	request: { credentials: RequestCredentials };
	parsed: { url: URL; clientUrl?: URL };
};
function allowCookies({ request, parsed }: CookieContext): boolean {
	return (
		request.credentials === "include" ||
		(request.credentials === "same-origin" &&
			parsed.url.origin !== "null" &&
			parsed.clientUrl?.origin === parsed.url.origin)
	);
}
export function applyCookieMode(api: ScramjetAPI, handler: FetchHandler): void {
	const hooks = handler.hooks.fetch as {
		request: { context: CookieContext; props: { init: { headers: RawHeaders } } };
		preresponse: { context: CookieContext; props: { response: { rawHeaders: RawHeaders } } };
	};
	api.Tap.tap(hooks.request, (ctx, { init }) => {
		if (!allowCookies(ctx))
			init.headers = init.headers.filter(([k]) => k.toLowerCase() !== "cookie");
	});
	api.Tap.tap(hooks.preresponse, (ctx, { response }) => {
		if (!allowCookies(ctx))
			response.rawHeaders = response.rawHeaders.filter(
				([k]) => k.toLowerCase() !== "set-cookie",
			);
	});
}
