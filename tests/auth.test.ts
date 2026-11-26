import { expect, test } from "vitest";

import { fakeUi, installAgy, said, start } from "./support/pi.ts";
import { answering } from "./support/record.ts";

test("a signed-out agent offers its sign-in methods, and the message goes through after sign-in", async () => {
	const { ui, dialogs } = fakeUi(["Log in with Google — Your Google account"]);
	const { session, stop, assistants } = await start({ ui, signedOut: true });
	await session.prompt("hello");
	expect(dialogs()[0]).toStrictEqual({
		title: "Antigravity needs you to sign in",
		options: ["Log in with Google — Your Google account", "Gemini API key"],
	});
	expect(said(assistants().at(-1))).toBe("echo: hello");
	const log = await stop();
	expect(log.signIns).toStrictEqual(["oauth-personal"]);
	expect(log.sessions.length).toBe(1);
});

test("declining to sign in, or having no UI, leaves the sign-in error", async () => {
	const { ui } = fakeUi([undefined]);
	const declined = await start({ ui, signedOut: true });
	await declined.session.prompt("hello");
	expect(declined.assistants().at(-1)?.errorMessage).toMatch(/needs you to sign in/);
	expect((await declined.stop()).signIns).toStrictEqual([]);
	const headless = await start({ signedOut: true });
	await headless.session.prompt("hello");
	expect(headless.assistants().at(-1)?.errorMessage).toMatch(/needs you to sign in/);
});

test("/agy login signs in with a chosen method; /agy logout asks first, then signs out", async () => {
	const { ui, notes } = fakeUi(["Gemini API key"]);
	const sure = answering([false, true]);
	const { session, stop } = await start({
		ui: { ...ui, confirm: () => Promise.resolve(sure() === true) },
	});
	await session.prompt("/agy login");
	expect(notes().at(-1)).toBe("info: Signed in to Antigravity with Gemini API key.");
	await session.prompt("/agy logout");
	expect(notes().at(-1)).toBe("info: Still signed in to Antigravity.");
	await session.prompt("/agy logout");
	expect(notes().at(-1)).toBe("info: Signed out of Antigravity.");
	const log = await stop();
	expect([log.signIns, log.logouts]).toStrictEqual([["gemini-api-key"], 1]);
});

test("a failed start of the agent is not remembered: once agy is there, /agy works", async () => {
	const { ui, notes } = fakeUi(["Gemini API key"]);
	const { session, home, stop } = await start({ ui, agy: false });
	await session.prompt("/agy login");
	expect(notes().at(-1)).toMatch(/^error: .*not found on PATH/);
	await installAgy(home);
	await session.prompt("/agy login");
	expect(notes().at(-1)).toBe("info: Signed in to Antigravity with Gemini API key.");
	expect((await stop()).signIns).toStrictEqual(["gemini-api-key"]);
});
