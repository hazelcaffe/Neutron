import { describe, expect, it } from "vitest";
import { parseProtocolURL, protocolURL } from "../src/shared/urls";

describe("virtual protocol URLs", () => {
	it("preserves native relative asset and module resolution", () => {
		const page = new URL(
			protocolURL("instance", "app://obsidian.md/folder/index.html"),
			"https://neutron.test",
		);
		expect(parseProtocolURL(new URL("../app.js", page))).toEqual({
			instanceId: "instance",
			url: "app://obsidian.md/app.js",
		});
		expect(parseProtocolURL(new URL("./lib/module.js?version=2#part", page))).toEqual({
			instanceId: "instance",
			url: "app://obsidian.md/folder/lib/module.js?version=2#part",
		});
	});
	it("accepts already-open legacy URLs and opaque custom schemes", () => {
		expect(
			parseProtocolURL(
				"https://neutron.test/__neutron_protocol__/id/app%3A%2F%2Fsite%2Findex.html",
			).url,
		).toBe("app://site/index.html");
		expect(
			parseProtocolURL(new URL(protocolURL("id", "custom:payload"), "https://neutron.test"))
				.url,
		).toBe("custom:payload");
	});
});
