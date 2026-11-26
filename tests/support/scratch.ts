import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

/** A new temporary directory, by its real path, removed when the test finishes. */
export async function scratchDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `pi-acp-${name}-`)));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Whether a process with this id is running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
