import { expect, test } from "vitest";

import { signIn } from "../src/sign-in.ts";
import { recorder } from "./support/record.ts";

const method = (id: string) => ({ id, name: "Google", description: "Sign in" });

test("the second of two sign-in methods with the same label can be chosen", async () => {
	const used = recorder<string>();
	const client = {
		signInMethods: [method("first"), method("second")],
		signIn: (id: string) => Promise.resolve(used.record(id)),
	};
	const pane = {
		hasUI: true,
		ui: { select: (_title: string, labels: string[]) => Promise.resolve(labels[1]) },
	};
	expect((await signIn(client, pane, "Sign in"))?.id).toBe("second");
	expect(used.all()).toStrictEqual(["second"]);
});

test("a cancelled sign-in dialog cannot authenticate with a late selection", async () => {
	const controller = new AbortController();
	const used = recorder<string>();
	const client = {
		signInMethods: [method("google")],
		signIn: (id: string) => Promise.resolve(used.record(id)),
	};
	const pane = {
		hasUI: true,
		ui: {
			select: async (_title: string, labels: string[]) => {
				controller.abort();
				return labels[0];
			},
		},
	};
	await expect(signIn(client, pane, "Sign in", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	expect(used.all()).toStrictEqual([]);
});

test("without a UI or a method, nobody signs in", async () => {
	const client = { signInMethods: [], signIn: () => Promise.reject(new Error("not called")) };
	const pane = { hasUI: true, ui: { select: () => Promise.resolve(undefined) } };
	expect(await signIn(client, pane, "Sign in")).toBeUndefined();
	expect(await signIn({ ...client, signInMethods: [method("m")] }, undefined, "Sign in")).toBeUndefined();
});
