import { describe, expect, it } from "vitest";
import { secondInstanceData } from "../src/runtime/electron";

describe("secondInstanceData", () => {
	const own = ["/neutron/electron", "--flag"];
	const link = ["/neutron/electron", "--protocol-launcher", "--", "app://open?x=1"];
	it("substitutes the second instance's argv wherever the lock data held this one's", () => {
		expect(
			secondInstanceData(
				{ originalArgs: [...own], nested: [{ argv: [...own] }], other: 1 },
				own,
				link,
			),
		).toEqual({ originalArgs: link, nested: [{ argv: link }], other: 1 });
	});
	it("keeps data that doesn't come from argv", () => {
		expect(secondInstanceData({}, own, link)).toEqual({});
		expect(secondInstanceData({ args: ["/neutron/electron"] }, own, link)).toEqual({
			args: ["/neutron/electron"],
		});
	});
});
