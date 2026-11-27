import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";

import { Inbox } from "../src/inbox.ts";

const usage = (used: number): SessionUpdate => ({ sessionUpdate: "usage_update", used, size: 10 });
const said = (sessionUpdate: "user_message_chunk" | "agent_message_chunk", text: string) =>
	({ sessionUpdate, content: { type: "text", text } }) satisfies SessionUpdate;

test("nothing is held for a session that sent nothing", () => {
	const inbox = new Inbox();
	expect(inbox.take("unknown")).toStrictEqual([]);
	expect(inbox.endReplay("unknown")).toBeUndefined();
	expect(inbox.take("")).toStrictEqual([]);
});

test("early updates are held once, up to 64 per session for the newest 16 sessions", () => {
	const inbox = new Inbox();
	for (let n = 0; n < 65; n++) inbox.hold("s", usage(n));
	const held = inbox.take("s");
	expect(held).toHaveLength(64);
	expect(held.at(-1)).toStrictEqual(usage(63));
	expect(inbox.take("s"), "taken updates are no longer held").toStrictEqual([]);
	for (let n = 0; n < 17; n++) inbox.hold(`s${n}`, usage(n));
	expect(inbox.take("s0"), "the oldest session was dropped for the 17th").toStrictEqual([]);
	expect(inbox.take("s16")).toStrictEqual([usage(16)]);
});

test("an accepted update refreshes eviction order, but an update over the limit does not", () => {
	const inbox = new Inbox();
	for (let n = 0; n < 64; n++) inbox.hold("full", usage(n));
	inbox.hold("refreshed", usage(1));
	inbox.hold("next oldest", usage(2));
	for (let n = 0; n < 13; n++) inbox.hold(`later${n}`, usage(n));
	inbox.hold("refreshed", usage(3));
	inbox.hold("full", usage(64));
	inbox.hold("new1", usage(4));
	inbox.hold("new2", usage(5));
	expect(inbox.take("full")).toStrictEqual([]);
	expect(inbox.take("next oldest")).toStrictEqual([]);
	expect(inbox.take("refreshed")).toStrictEqual([usage(1), usage(3)]);
	expect(inbox.take("new1")).toStrictEqual([usage(4)]);
	expect(inbox.take("new2")).toStrictEqual([usage(5)]);
});

test("a replay counts each turn the user starts and keeps the text only when asked", () => {
	const inbox = new Inbox();
	inbox.startReplay("s", true);
	for (const update of [said("user_message_chunk", "hi"), said("user_message_chunk", "!")]) inbox.hold("s", update);
	inbox.hold("s", said("agent_message_chunk", "hello"));
	inbox.hold("s", said("user_message_chunk", "again"));
	inbox.hold("s", usage(5));
	expect(inbox.endReplay("s")).toStrictEqual({
		turns: 2,
		userSpeaking: true,
		exchanges: [
			{ user: "hi!", agent: "hello" },
			{ user: "again", agent: "" },
		],
	});
	expect(inbox.take("s"), "settings sent during the replay are kept").toStrictEqual([usage(5)]);
	inbox.startReplay("t", false);
	inbox.hold("t", said("user_message_chunk", "x"));
	expect(inbox.endReplay("t")).toStrictEqual({
		turns: 1,
		userSpeaking: true,
		exchanges: undefined,
	});
});

test("settings sent in the middle of a user message do not start a new turn", () => {
	const inbox = new Inbox();
	inbox.startReplay("s", true);
	inbox.hold("s", said("user_message_chunk", "hello"));
	inbox.hold("s", usage(1));
	inbox.hold("s", said("user_message_chunk", " world"));
	inbox.hold("s", said("agent_message_chunk", "hi"));
	expect(inbox.endReplay("s")?.exchanges).toStrictEqual([{ user: "hello world", agent: "hi" }]);
});

test("a newer plan update from the agent ends the user's turn like any agent update", () => {
	const inbox = new Inbox();
	inbox.startReplay("s", false);
	inbox.hold("s", said("user_message_chunk", "one"));
	inbox.hold("s", { sessionUpdate: "plan_removed", planId: "p" });
	inbox.hold("s", said("user_message_chunk", "two"));
	expect(inbox.endReplay("s")?.turns).toBe(2);
});
