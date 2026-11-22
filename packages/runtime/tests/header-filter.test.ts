import { describe, expect, it } from "vitest";
import { headerRecord, rawHeaders, resourceType } from "../src/core/header-filter";

describe("renderer webRequest header details", () => {
	it("maps Scramjet destinations and header lists to Electron's shapes", () => {
		expect(resourceType("iframe")).toBe("mainFrame");
		expect(resourceType("iframe", true)).toBe("subFrame");
		expect(resourceType("style")).toBe("stylesheet");
		expect(resourceType("")).toBe("xhr");
		expect(resourceType("worker")).toBe("other");
		const record = headerRecord([
			["Content-Type", "text/plain"],
			["set-cookie", "a=1"],
			["Set-Cookie", "b=2"],
		]);
		expect(record).toEqual({ "Content-Type": ["text/plain"], "set-cookie": ["a=1", "b=2"] });
		expect(rawHeaders({ ...record, "X-One": "1" })).toEqual([
			["Content-Type", "text/plain"],
			["set-cookie", "a=1"],
			["set-cookie", "b=2"],
			["X-One", "1"],
		]);
	});
});
