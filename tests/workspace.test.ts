import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { fakeUi, said, start } from "./support/pi.ts";

const withMcp = (servers: unknown) => async (dir: string) => {
	await mkdir(join(dir, "pi"), { recursive: true });
	await writeFile(join(dir, "pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
};

test("--agy-dir passes extra directories, resolved from the workspace, and reports missing ones", async () => {
	const { ui, notes } = fakeUi();
	const flags = { "agy-dir": ["lib", "missing", ""].join(delimiter) };
	const { session, stop, work } = await start({
		ui,
		flags,
		setup: async (dir) => {
			await mkdir(join(dir, "work", "lib"), { recursive: true });
		},
	});
	await session.prompt("hello");
	const log = await stop();
	expect(log.sessions[0]?.additionalDirectories).toStrictEqual([join(work, "lib")]);
	expect(notes()).toContain(
		`warning: --agy-dir ${join(work, "missing")} is not a directory, so the agent does not get it.`,
	);
});

test("--agy-dir reports an inaccessible path instead of failing the message", async () => {
	const { ui, notes } = fakeUi();
	const { session, stop, assistants, work } = await start({
		ui,
		flags: { "agy-dir": join("locked", "inner") },
		setup: async (dir) => {
			const locked = join(dir, "work", "locked");
			if (process.platform === "win32") {
				await writeFile(locked, "not a directory");
			} else {
				await mkdir(join(locked, "inner"), { recursive: true });
				onTestFinished(() => chmod(locked, 0o755));
				await chmod(locked, 0o000);
			}
		},
	});
	await session.prompt("hello");
	expect(said(assistants().at(-1))).toBe("echo: hello");
	expect(notes()).toContain(
		`warning: --agy-dir ${join(work, "locked", "inner")} is not a directory, so the agent does not get it.`,
	);
	expect((await stop()).sessions[0]?.additionalDirectories).toBeUndefined();
});

test("--agy-mcp gives the agent Pi's stdio MCP servers; without it the agent gets none", async () => {
	const setup = withMcp({ files: { command: "/bin/fs-mcp", args: ["."] } });
	const on = await start({ flags: { "agy-mcp": true }, setup });
	await on.session.prompt("hello");
	expect((await on.stop()).sessions[0]?.mcpServers).toStrictEqual([
		{ name: "files", command: "/bin/fs-mcp", args: ["."], env: [] },
	]);
	const off = await start({ setup });
	await off.session.prompt("hello");
	expect((await off.stop()).sessions[0]?.mcpServers).toStrictEqual([]);
});

test("--agy-mcp says which HTTP servers an agent without HTTP support does not get", async () => {
	const { ui, notes } = fakeUi();
	const setup = withMcp({
		docs: { url: "https://docs.example/mcp" },
		events: { type: "sse", url: "https://docs.example/events" },
	});
	const { session, stop } = await start({ ui, flags: { "agy-mcp": true }, setup });
	await session.prompt("hello");
	expect(notes()).toContain("warning: MCP server docs: this agent takes no HTTP servers; it does not get it.");
	expect(notes()).toContain(
		"warning: MCP server events: the SSE transport is not supported; the agent does not get it.",
	);
	expect((await stop()).sessions[0]?.mcpServers).toStrictEqual([]);
});
