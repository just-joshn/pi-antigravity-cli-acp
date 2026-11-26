import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

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

/** Refuses devices, pipes and huge files, which would never finish loading or exhaust memory. */
async function requireReadable(path: string) {
  // A path that cannot be examined is reported by the read itself.
  const info = await stat(path).catch(() => undefined);
  if (info && !info.isFile() && !info.isDirectory())
    throw RequestError.invalidParams(undefined, `${path} is not a regular file`);
  if (info && info.size > READ_LIMIT_MIB * MIB)
    throw RequestError.invalidParams(undefined, `${path} is larger than ${READ_LIMIT_MIB} MiB`);
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
    const code = codeOf(error);
    if (code === "ENOENT") throw RequestError.resourceNotFound(path);
    throw RequestError.internalError(undefined, `${path} could not be read (${code})`);
  });
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
  // Windows has no O_NOFOLLOW; there, creating a symbolic link needs privileges the agent lacks.
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow;
  const file = await open(target, flags).catch((error: unknown) => {
    const code = codeOf(error);
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

/** `path` must be strictly inside one of `roots`. */
function requireInside(roots: readonly string[], path: string) {
  const within = (root: string) => {
    const inside = relative(root, path);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  };
  if (!roots.some(within)) throw outsideWorkspace();
}
