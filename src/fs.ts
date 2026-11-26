import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { buffer } from "node:stream/consumers";

import {
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  RequestError,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk/unstable";

const MIB = 1024 * 1024;
/** Largest file the agent may read through Pi, in MiB. */
const READ_LIMIT_MIB = 16;

/** The system error code of a failed file operation, such as `ENOENT`. */
function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "unknown";
}

function requireAbsolute(path: string) {
  if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, "path must be absolute");
}

function tooLarge(path: string) {
  return RequestError.invalidParams(undefined, `${path} is larger than ${READ_LIMIT_MIB} MiB`);
}

function notRegular(path: string) {
  return RequestError.invalidParams(undefined, `${path} is not a regular file`);
}

/**
 * The text of the file at `path`. Devices, pipes and huge files are refused, as they would never
 * finish loading or would exhaust memory. The checks look at the file opened, so it cannot be
 * swapped between check and read; opening does not wait for a pipe's writer.
 */
async function readChecked(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(
    (error: unknown) => {
      const code = codeOf(error);
      if (code === "ENOENT") throw RequestError.resourceNotFound(path);
      throw RequestError.internalError(undefined, `${path} could not be read (${code})`);
    },
  );
  try {
    const info = await file.stat();
    if (!info.isFile() && !info.isDirectory()) throw notRegular(path);
    if (info.size > READ_LIMIT_MIB * MIB) throw tooLarge(path);
    // At most one byte past the limit is read, so a file that grows after the check is refused too.
    const bytes = await buffer(
      file.createReadStream({ end: READ_LIMIT_MIB * MIB, autoClose: false }),
    ).catch((error: unknown) => {
      throw RequestError.internalError(undefined, `${path} could not be read (${codeOf(error)})`);
    });
    if (bytes.length > READ_LIMIT_MIB * MIB) throw tooLarge(path);
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

/** Serves ACP `fs/read_text_file`: the whole file, or `limit` lines from 1-based `line`. */
export async function readTextFile({
  path,
  line,
  limit,
}: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  requireAbsolute(path);
  const text = await readChecked(path);
  const first = line ?? undefined;
  const count = limit ?? undefined;
  if (first === undefined && count === undefined) return { content: text };
  // ACP's line and limit are whole numbers; a fraction is cut down and a negative count is none.
  const start = Math.max(Math.trunc(first ?? 1) - 1, 0);
  const lines = text.split("\n");
  return {
    content: lines
      .slice(start, count === undefined ? undefined : start + Math.max(Math.trunc(count), 0))
      .join("\n"),
  };
}

/** Resolves symlinks in the part of `path` that exists, so a link cannot lead out of the workspace. */
async function canonical(path: string): Promise<string> {
  const real = await realpath(path).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return undefined;
    throw RequestError.internalError(undefined, `${path} could not be resolved (${codeOf(error)})`);
  });
  if (real !== undefined) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await canonical(parent), basename(path));
}

/**
 * Serves ACP `fs/write_text_file`, creating missing parent directories as an editor would.
 * Pi writes only inside the session's workspaces: its directory and any extra ones it was given.
 * The agent's permission mode governs the rest.
 */
export async function writeTextFile(
  { path, content }: WriteTextFileRequest,
  workspaces: readonly string[],
) {
  requireAbsolute(path);
  const roots = await Promise.all(workspaces.map(canonical));
  requireInside(roots, await canonical(path));
  await mkdir(dirname(path), { recursive: true });
  // The agent can change the tree meanwhile: check the real parent again, and never follow a link
  // at the file itself.
  const target = join(await realpath(dirname(path)), basename(path));
  requireInside(roots, target);
  // A link at the file itself is refused here, and O_NOFOLLOW closes the moment between this check
  // and the open. Windows has no O_NOFOLLOW, so there only this check applies. A target that cannot
  // be examined is left to the open, which reports why.
  if ((await lstat(target).catch(() => undefined))?.isSymbolicLink()) throw outsideWorkspace();
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  // Opening does not wait for a pipe's reader; a pipe with none fails with ENXIO.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | noFollow;
  const file = await open(target, flags).catch((error: unknown) => {
    const code = codeOf(error);
    if (code === "ELOOP") throw outsideWorkspace();
    if (code === "ENXIO") throw notRegular(path);
    throw RequestError.internalError(undefined, `${path} could not be written (${code})`);
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw notRegular(path);
    // A hard link can name a file outside the workspace; it is not emptied or written.
    if (info.nlink > 1) throw outsideWorkspace();
    await file.truncate(0);
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

/** `path` must be strictly inside one of `roots`. */
function requireInside(roots: readonly string[], path: string) {
  const within = (root: string) => {
    const inside = relative(root, path);
    const above = inside === ".." || inside.startsWith(`..${sep}`);
    return inside !== "" && !above && !isAbsolute(inside);
  };
  if (!roots.some(within)) throw outsideWorkspace();
}
