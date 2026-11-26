import { execFileSync } from "node:child_process";
import { link, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";

import { readTextFile, writeTextFile } from "../src/fs.ts";
import { scratchDir } from "./support/scratch.ts";

const code = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => (error instanceof RequestError ? error.code : error),
	);

const read = (path: string) => code(readTextFile({ sessionId: "s", path }));
const writeIn = (workspace: string | undefined, path: string) =>
	code(writeTextFile({ sessionId: "s", path, content: "x" }, workspace === undefined ? [] : [workspace]));

test("reading returns the whole file, or limit lines from a 1-based line", async () => {
	const dir = await scratchDir("fs");
	const path = join(dir, "lines.txt");
	await writeFile(path, "one\ntwo\nthree\nfour");
	const lines = (line?: number | null, limit?: number | null) =>
		readTextFile({
			sessionId: "s",
			path,
			...(line === undefined ? {} : { line }),
			...(limit === undefined ? {} : { limit }),
		}).then((reply) => reply.content);
	expect(await lines()).toBe("one\ntwo\nthree\nfour");
	expect(await lines(null, null)).toBe("one\ntwo\nthree\nfour");
	expect(await lines(2, 2)).toBe("two\nthree");
	expect(await lines(3)).toBe("three\nfour");
	expect(await lines(undefined, 1)).toBe("one");
	expect(await lines(-5, 1), "a line before the first starts at the first").toBe("one");
	expect(await lines(1, -1), "a negative limit gives nothing").toBe("");
	expect(await lines(2.5, 1.5), "fractions are cut down").toBe("two");
	expect(await lines(10, 2), "a line past the end gives nothing").toBe("");
	expect(await lines(0, 1), "line 0 reads from the start").toBe("one");
});

test("reading an empty file, or zero lines, gives empty text", async () => {
	const dir = await scratchDir("fs");
	const path = join(dir, "empty.txt");
	await writeFile(path, "");
	expect((await readTextFile({ sessionId: "s", path })).content).toBe("");
	await writeFile(path, "one\ntwo");
	expect((await readTextFile({ sessionId: "s", path, line: 1, limit: 0 })).content).toBe("");
	expect((await readTextFile({ sessionId: "s", path, line: 9 })).content).toBe("");
});

test("reading refuses relative paths and reports missing or unreadable files", async () => {
	const dir = await scratchDir("fs");
	expect(await read("relative.txt")).toBe(RequestError.invalidParams().code);
	expect(await read(join(dir, "absent.txt"))).toBe(RequestError.resourceNotFound().code);
	expect(await read(dir), "a directory is not a text file").toBe(RequestError.internalError().code);
});

test("writing stays inside the workspace, even through a symlink", async () => {
	const dir = await scratchDir("fs");
	const work = join(dir, "work");
	await mkdir(work);
	await symlink(dir, join(work, "escape"));
	const write = (path: string) => writeIn(work, path);
	const refused = RequestError.invalidParams().code;

	expect(await write("relative.txt")).toBe(refused);
	expect(await writeIn(undefined, join(work, "a.txt")), "no workspace, no writes").toBe(refused);
	expect(await write(work), "the workspace itself is not a file").toBe(refused);
	expect(await write(join(work, "escape", "out.txt"))).toBe(refused);
	expect(await write(join(work, "..", "out.txt"))).toBe(refused);

	expect(await write(join(work, "new", "deeper", "in.txt"))).toBeUndefined();
	expect(await write(join(work, "..notes")), "a name starting with two dots is inside").toBeUndefined();
	await writeTextFile({ sessionId: "s", path: join(work, "blank.txt"), content: "" }, [work]);
	expect(await readFile(join(work, "blank.txt"), "utf8")).toBe("");
	expect(await readFile(join(work, "new", "deeper", "in.txt"), "utf8")).toBe("x");
});

test("writing through a symbolic link loop is refused with the reason", async () => {
	const work = await scratchDir("fs");
	await symlink(join(work, "loop"), join(work, "loop"));
	const failure = await writeTextFile({ sessionId: "s", path: join(work, "loop", "x.txt"), content: "x" }, [
		work,
	]).catch((error: unknown) => error);
	expect.assert(failure instanceof RequestError);
	expect(failure.message).toContain(`${join(work, "loop", "x.txt")} could not be resolved (ELOOP)`);
});

test("a file that cannot be read is named in the error with the reason", async () => {
	const dir = await scratchDir("fs");
	const failure = await readTextFile({ sessionId: "s", path: dir }).catch((error: unknown) => error);
	expect.assert(failure instanceof RequestError);
	expect(failure.message).toContain(`${dir} could not be read (EISDIR)`);
});

test("reading refuses devices and files over 16 MB instead of loading them", async () => {
	const dir = await scratchDir("fs");
	const big = join(dir, "big.txt");
	await writeFile(big, "");
	await truncate(big, 16 * 1024 * 1024 + 1);
	expect(await read(big)).toBe(RequestError.invalidParams().code);
	const device = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/zero";
	expect(await read(device)).toBe(RequestError.invalidParams().code);
});

test("a write through a hard link is refused, as it could change a file outside the workspace", async () => {
	const dir = await scratchDir("fs");
	const work = join(dir, "work");
	await mkdir(work);
	await writeFile(join(dir, "outside.txt"), "keep");
	await link(join(dir, "outside.txt"), join(work, "linked.txt"));
	expect(await writeIn(work, join(work, "linked.txt"))).toBe(RequestError.invalidParams().code);
	expect(await readFile(join(dir, "outside.txt"), "utf8")).toBe("keep");
});

test("a named pipe is refused for writing at once, not waited on", async () => {
	const work = await scratchDir("fs");
	const pipe = process.platform === "win32" ? "\\\\.\\pipe\\pi-acp-file-test" : join(work, "pipe");
	if (process.platform !== "win32") execFileSync("mkfifo", [pipe]);
	expect(await writeIn(work, pipe)).toBe(RequestError.invalidParams().code);
	expect(await read(pipe), "and for reading").toBe(RequestError.invalidParams().code);
});
