import { delimiter } from "node:path";

import { expect, test } from "vitest";

import { readFlags } from "../src/flags.ts";

const flagsOf = (values: Readonly<Record<string, string | boolean>>) => readFlags({ getFlag: (name) => values[name] });

test("flags that were not given take their defaults", () => {
	expect(flagsOf({})).toStrictEqual({
		agent: "auto",
		mode: undefined,
		directories: [],
		mcp: false,
	});
});

test("flags as typed are read as typed", () => {
	const typed = {
		"agy-agent": "registry",
		"agy-mode": "yolo",
		"agy-dir": ["a", "b"].join(delimiter),
		"agy-mcp": true,
	};
	expect(flagsOf(typed)).toStrictEqual({
		agent: "registry",
		mode: "yolo",
		directories: ["a", "b"],
		mcp: true,
	});
});

test("empty, blank and wrongly typed flags fall back to their defaults", () => {
	expect(flagsOf({ "agy-agent": "", "agy-mode": "", "agy-dir": "", "agy-mcp": false })).toStrictEqual({
		agent: "auto",
		mode: undefined,
		directories: [],
		mcp: false,
	});
	expect(flagsOf({ "agy-agent": "zed", "agy-dir": [" ", "", "x"].join(delimiter) })).toMatchObject({
		agent: "auto",
		directories: ["x"],
	});
	expect(flagsOf({ "agy-agent": true, "agy-mode": true, "agy-dir": true, "agy-mcp": "yes" })).toStrictEqual({
		agent: "auto",
		mode: undefined,
		directories: [],
		mcp: false,
	});
});
