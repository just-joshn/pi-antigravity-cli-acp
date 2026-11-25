import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  RequestError,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk/unstable";

/** Largest file the agent may read through Pi. */
const READ_LIMIT = 16 * 1024 * 1024;

function requireAbsolute(path: string) {
  if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, "path must be absolute");
}

/** Refuses devices, pipes and huge files, which would never finish loading or exhaust memory. */
async function requireReadable(path: string) {
  // A path that cannot be examined is reported by the read itself.
  const info = await stat(path).catch(() => undefined);
  if (info && !info.isFile() && !info.isDirectory())
    throw RequestError.invalidParams(undefined, `${path} is not a regular file`);
  if (info && info.size > READ_LIMIT)
    throw RequestError.invalidParams(undefined, `${path} is larger than 16 MiB`);
}

/** Serves ACP `fs/read_text_file`: the whole file, or `limit` lines from 1-based `line`. */
export async function readTextFile({
  path,
  line,
  limit,
}: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  requireAbsolute(path);
  await requireReadable(path);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") throw RequestError.resourceNotFound(path);
    throw RequestError.internalError(undefined, `${path} could not be read (${code})`);
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
  if (workspace === undefined) throw outsideWorkspace();
  const root = await canonical(workspace);
  requireInside(root, await canonical(path));
  await mkdir(dirname(path), { recursive: true });
  // The agent can change the tree meanwhile: check the real parent again, and never follow a link
  // at the file itself.
  const target = join(await realpath(dirname(path)), basename(path));
  requireInside(root, target);
  // Windows has no O_NOFOLLOW; there, creating a symbolic link needs privileges the agent lacks.
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow;
  const file = await open(target, flags).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (code === "ELOOP") throw outsideWorkspace();
    throw RequestError.internalError(undefined, `${path} could not be written (${code})`);
  });
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
  return {};
}

function outsideWorkspace() {
  return RequestError.invalidParams(
    undefined,
    "this client writes files only inside the session's workspace",
  );
}

function requireInside(root: string, path: string) {
  const inside = relative(root, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw outsideWorkspace();
}
