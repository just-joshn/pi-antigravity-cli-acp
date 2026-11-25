import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  RequestError,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk/unstable";

function requireAbsolute(path: string) {
  if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, "path must be absolute");
}

/** Serves ACP `fs/read_text_file`: the whole file, or `limit` lines from 1-based `line`. */
export async function readTextFile({
  path,
  line,
  limit,
}: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  requireAbsolute(path);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw RequestError.resourceNotFound(path);
    throw RequestError.internalError(undefined, "the file could not be read");
  });
  const first = line ?? undefined;
  const count = limit ?? undefined;
  if (first === undefined && count === undefined) return { content: text };
  const start = Math.max((first ?? 1) - 1, 0);
  const lines = text.split("\n");
  return {
    content: lines.slice(start, count === undefined ? undefined : start + count).join("\n"),
  };
}

/** Resolves symlinks in the part of `path` that exists, so a link cannot lead out of the workspace. */
async function canonical(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- walks up one directory at a time until one exists
    const real = await realpath(existing).catch(() => undefined);
    if (real !== undefined) return join(real, ...missing);
    const parent = dirname(existing);
    if (parent === existing) return path;
    missing.unshift(existing.slice(parent.length).replaceAll(sep, ""));
    existing = parent;
  }
}

/**
 * Serves ACP `fs/write_text_file`, creating missing parent directories as an editor would.
 * Pi writes only inside the session's workspace; the agent's permission mode governs the rest.
 */
export async function writeTextFile(
  { path, content }: WriteTextFileRequest,
  workspace: string | undefined,
) {
  requireAbsolute(path);
  const inside =
    workspace === undefined ? ".." : relative(await canonical(workspace), await canonical(path));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    throw RequestError.invalidParams(
      undefined,
      "this client writes files only inside the session's workspace",
    );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return {};
}
