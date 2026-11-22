import type { RuntimeConfig } from "../shared/types";

// Capture engine metadata before a guest page receives a custom user agent.
const nativeAgent = navigator.userAgent;
export const electronVersion = "33.0.0";
export const chromeVersion =
	/(?:HeadlessChrome|Chrome|Chromium)\/([\d.]+)/.exec(nativeAgent)?.[1] || "130.0.6723.58";
export const runtimeArch = /\b(aarch64|arm64)\b/i.test(nativeAgent) ? "arm64" : "x64";

export function defaultUserAgent({ app, platform }: RuntimeConfig): string {
	const os =
		platform === "win32"
			? "Windows NT 10.0; Win64; x64"
			: platform === "darwin"
				? "Macintosh; Intel Mac OS X 10_15_7"
				: `X11; Linux ${runtimeArch === "arm64" ? "aarch64" : "x86_64"}`;
	const token = (value: string) =>
		value.replace(/\s+/g, "").replace(/[^a-zA-Z0-9!#$%&'*+.^_`|~-]/g, "-");
	const product = `${token(app.manifest.name)}/${token(app.manifest.version)}`;
	return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) ${product} Chrome/${chromeVersion} Electron/${electronVersion} Safari/537.36`;
}
