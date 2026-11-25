import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { readTextFile, writeTextFile } from "../src/fs.ts";

async function scratch() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-fs-unit-")));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof RequestError ? error.code : error),
  );

const read = (path: string) => code(readTextFile({ sessionId: "s", path }));
const writeIn = (workspace: string | undefined, path: string) =>
  code(writeTextFile({ sessionId: "s", path, content: "x" }, workspace));

test("reading returns the whole file, or limit lines from a 1-based line", async () => {
  const dir = await scratch();
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
  expect(await lines(0, 1), "line 0 reads from the start").toBe("one");
});

test("reading refuses relative paths and reports missing or unreadable files", async () => {
  const dir = await scratch();
  expect(await read("relative.txt")).toBe(RequestError.invalidParams().code);
  expect(await read(join(dir, "absent.txt"))).toBe(RequestError.resourceNotFound().code);
  expect(await read(dir), "a directory is not a text file").toBe(RequestError.internalError().code);
});

test("writing stays inside the workspace, even through a symlink", async () => {
  const dir = await scratch();
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
  expect(await readFile(join(work, "new", "deeper", "in.txt"), "utf8")).toBe("x");
});
