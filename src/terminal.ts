import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  type CreateTerminalRequest,
  RequestError,
  type TerminalExitStatus,
  type TerminalOutputResponse,
} from "@agentclientprotocol/sdk/unstable";

/** Output kept when the agent sets no limit, so a noisy command cannot exhaust memory. */
const DEFAULT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 1000;

interface Running {
  sessionId: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit: TerminalExitStatus | undefined;
  exited: Promise<TerminalExitStatus>;
}

/** Keeps the last `limit` bytes of `text`, cut at a character boundary. */
function keepEnd(text: string, limit: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, cut: false };
  let start = bytes.length - limit;
  // Continuation bytes are 10xxxxxx; a character starts at the first byte that is not one.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), cut: true };
}

/**
 * Commands the agent runs through Pi (ACP `terminal/*`). Each runs without a shell, in the
 * session's directory unless the agent names another absolute one.
 */
export class Terminals {
  #all = new Map<string, Running>();
  #count = 0;
  #onOutput: (sessionId: string, terminalId: string, output: string) => void;

  constructor(onOutput: (sessionId: string, terminalId: string, output: string) => void) {
    this.#onOutput = onOutput;
  }

  create(request: CreateTerminalRequest, sessionCwd: string): { terminalId: string } {
    const cwd = request.cwd ?? sessionCwd;
    if (!isAbsolute(cwd))
      throw RequestError.invalidParams(undefined, "the working directory must be absolute");
    const env = { ...process.env };
    for (const variable of request.env ?? []) env[variable.name] = variable.value;
    const child = spawn(request.command, request.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#count += 1;
    const terminalId = `pi-terminal-${this.#count}`;
    const running: Running = {
      sessionId: request.sessionId,
      child,
      output: "",
      truncated: false,
      limit: request.outputByteLimit ?? DEFAULT_LIMIT,
      exit: undefined,
      exited: new Promise((resolve) => {
        const end = (exit: TerminalExitStatus) => {
          running.exit ??= exit;
          resolve(running.exit);
        };
        child.once("close", (exitCode, signal) => end({ exitCode, signal }));
        child.once("error", (error) => {
          this.#append(terminalId, running, `${error.message}\n`);
          end({ exitCode: null, signal: null });
        });
      }),
    };
    const append = (chunk: Buffer) => this.#append(terminalId, running, chunk.toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    this.#all.set(terminalId, running);
    return { terminalId };
  }

  output(sessionId: string, terminalId: string): TerminalOutputResponse {
    const { output, truncated, exit } = this.#get(sessionId, terminalId);
    return { output, truncated, ...(exit ? { exitStatus: exit } : {}) };
  }

  waitForExit(sessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    return this.#get(sessionId, terminalId).exited;
  }

  kill(sessionId: string, terminalId: string): Record<string, never> {
    const { child, exit } = this.#get(sessionId, terminalId);
    if (exit) return {};
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    child.once("close", () => clearTimeout(force));
    return {};
  }

  release(sessionId: string, terminalId: string): Record<string, never> {
    this.kill(sessionId, terminalId);
    this.#all.delete(terminalId);
    return {};
  }

  releaseSession(sessionId: string) {
    for (const [terminalId, running] of this.#all)
      if (running.sessionId === sessionId) this.release(sessionId, terminalId);
  }

  releaseAll() {
    for (const [terminalId, running] of this.#all) this.release(running.sessionId, terminalId);
  }

  /** A terminal of `sessionId`; one session cannot reach another's. */
  #get(sessionId: string, terminalId: string): Running {
    const running = this.#all.get(terminalId);
    if (running?.sessionId !== sessionId)
      throw RequestError.invalidParams(undefined, `no terminal ${terminalId}`);
    return running;
  }

  #append(terminalId: string, running: Running, text: string) {
    const kept = keepEnd(running.output + text, running.limit);
    running.output = kept.text;
    running.truncated ||= kept.cut;
    this.#onOutput(running.sessionId, terminalId, running.output);
  }
}
