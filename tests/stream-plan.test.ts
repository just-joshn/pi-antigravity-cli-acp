import { expect, test } from "vitest";

import { anchorFor, parseAnchor } from "../src/conversation.ts";
import { noUsage } from "../src/draft.ts";
import { lastAnchor, planTurn, renderHistory } from "../src/stream.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const result = (toolCallId: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "antigravity_tool",
	content: [{ type: "text" as const, text: "out" }],
	isError: false,
	timestamp: 3,
});
const reply = (responseId: string | undefined, provider = "antigravity") => ({
	role: "assistant" as const,
	api: "x",
	provider,
	model: "m",
	content: [{ type: "toolCall" as const, id: "call-1", name: "antigravity_tool", arguments: {} }],
	usage: noUsage(),
	stopReason: "toolUse" as const,
	timestamp: 2,
	...(responseId === undefined ? {} : { responseId }),
});
const system = { role: "system" as const, content: "rules", timestamp: 0 };

test("a first message is the whole prompt, and a stamped reply with its results has nothing new", () => {
	expect(planTurn([], undefined)).toStrictEqual({ diverged: false, missed: [], prompt: [] });
	expect(planTurn([system, user("hi")], undefined)).toStrictEqual({
		diverged: false,
		missed: [],
		prompt: [user("hi")],
	});
	const continued = planTurn([system, user("hi"), reply("s/1.1"), result("call-1")], "s/1.1");
	expect(continued).toStrictEqual({ diverged: false, missed: [], prompt: [] });
});

test("messages typed after the stamped reply are sent; another model's turns are supplied as missed", () => {
	const steered = planTurn([user("hi"), reply("s/1.1"), result("call-1"), user("a"), user("b")], "s/1.1");
	expect(steered.prompt).toStrictEqual([user("a"), user("b")]);
	expect(steered.missed).toStrictEqual([]);
	const foreign = planTurn(
		[user("hi"), reply("s/1.1"), result("call-1"), user("q"), reply(undefined, "other"), user("now")],
		"s/1.1",
	);
	expect([foreign.diverged, foreign.missed.length, foreign.prompt]).toStrictEqual([false, 2, [user("now")]]);
});

test("a transcript whose last stamped reply is not the session's position has diverged", () => {
	const rewound = planTurn([system, user("hi"), reply("s/1.1"), result("call-1"), user("x")], "s/2.1");
	expect([rewound.diverged, rewound.missed.length]).toStrictEqual([true, 3]);
	expect(planTurn([user("hi")], "s/1.1").diverged).toBe(true);
});

test("history is rendered as text without thinking, and nothing is rendered for nothing said", () => {
	expect(renderHistory([])).toBe("");
	expect(renderHistory([{ ...reply("s"), content: [] }])).toBe("");
	const history = renderHistory([
		user("question"),
		{
			...reply("s"),
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "secret" },
			],
		},
		reply("s"),
		result("call-1"),
		{
			role: "user",
			content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
			timestamp: 4,
		},
	]);
	expect(history).toMatch(
		/^Conversation so far, supplied by the client as context:\n\nUser: question\n\nAssistant: answer\n\nAssistant: \[tool antigravity_tool: \{\}\]\n\nTool result \(antigravity_tool\): out\n\nUser: \[image\]$/,
	);
});

test("long history keeps its most recent part", () => {
	const long = renderHistory([user("a".repeat(30_000)), user("END")]);
	expect(long.length).toBeLessThan(24_200);
	expect(long.length, "the kept part is not cut short").toBeGreaterThan(24_000);
	expect(long).toMatch(/\[earlier conversation omitted\][\s\S]*END$/);
});

test("a saved anchor names the agent session and its turn count; anything else is no anchor", () => {
	expect(parseAnchor("s1/3.0")).toStrictEqual({ sessionId: "s1", turns: 3 });
	expect(parseAnchor("a/b/0.12")).toStrictEqual({ sessionId: "a/b", turns: 0 });
	expect(parseAnchor(`s/${Number.MAX_SAFE_INTEGER}.0`)?.turns).toBe(Number.MAX_SAFE_INTEGER);
	for (const bad of ["", "s1", "s1/", "/3.0", "s1/3", "s1/3.", "s1/-1.0", "s1/x.0", "s1/3.0 "])
		expect(parseAnchor(bad), bad).toBe(undefined);
});

test("the last anchor is from the newest reply this provider stamped, or none", () => {
	expect(lastAnchor([])).toStrictEqual({ index: -1, anchor: undefined });
	expect(lastAnchor([user("hi"), reply(undefined), reply("s/1.0", "other")])).toStrictEqual({
		index: -1,
		anchor: undefined,
	});
	expect(lastAnchor([reply("s/1.0"), user("hi"), reply("s/2.0"), user("again")])).toStrictEqual({
		index: 2,
		anchor: "s/2.0",
	});
});

test("an anchor written for a session reads back as that session and turn count", () => {
	expect(parseAnchor(anchorFor("s1", 0, 1))).toStrictEqual({ sessionId: "s1", turns: 0 });
	expect(parseAnchor(anchorFor("a/b", 7, 2))).toStrictEqual({ sessionId: "a/b", turns: 7 });
	expect(parseAnchor(anchorFor("", 1, 1)), "an anchor needs a session id").toBe(undefined);
});
