import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  type CreateTerminalRequest,
  RequestError,
  type TerminalExitStatus,
  type TerminalOutputResponse,
} from "@agentclientprotocol/sdk/unstable";

/** Most output kept per terminal, whatever the agent asks for, so a noisy command cannot exhaust memory. */
const OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 1000;
/** After the command exits, how long to wait for output still held by processes it left behind. */
const DRAIN_MS = 1000;
/** Process groups let a stop reach what the command started; Windows has none to signal. */
const GROUPS = process.platform !== "win32";

type Report = (sessionId: string, terminalId: string, output: string | undefined) => void;

interface Running {
  sessionId: string;
  child: ChildProcess;
  output: string;
  /** UTF-8 size of `output`, which may exceed `limit` until it is next trimmed. */
  bytes: number;
  truncated: boolean;
  limit: number;
  /** An output report is scheduled; reports are coalesced so a flood of chunks costs one each. */
  reporting: boolean;
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

function trim(running: Running) {
  if (running.bytes <= running.limit) return;
  const kept = keepEnd(running.output, running.limit);
  running.output = kept.text;
  running.bytes = Buffer.byteLength(kept.text);
  running.truncated ||= kept.cut;
}

/** Signals the command and everything it started, where the platform allows. */
function signal(child: ChildProcess, name: NodeJS.Signals) {
  if (GROUPS && child.pid !== undefined) {
    try {
      process.kill(-child.pid, name);
      return;
    } catch {
      // The group is gone already; signalling the command itself below is harmless.
    }
  }
  child.kill(name);
}

/**
 * Commands the agent runs through Pi (ACP `terminal/*`). Each runs without a shell, in the
 * session's directory unless the agent names another absolute one.
 */
export class Terminals {
  #all = new Map<string, Running>();
  #count = 0;
  #report: Report;

  /** `report` hears a terminal's output as it grows, and undefined once it is released. */
  constructor(report: Report) {
    this.#report = report;
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
      detached: GROUPS,
    });
    this.#count += 1;
    const terminalId = `pi-terminal-${this.#count}`;
    const running: Running = {
      sessionId: request.sessionId,
      child,
      output: "",
      bytes: 0,
      truncated: false,
      limit: Math.max(0, Math.min(request.outputByteLimit ?? OUTPUT_LIMIT, OUTPUT_LIMIT)),
      reporting: false,
      exit: undefined,
      exited: this.#exited(terminalId, child, () => running),
    };
    const append = (chunk: Buffer) => this.#append(terminalId, running, chunk.toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    this.#all.set(terminalId, running);
    return { terminalId };
  }

  output(sessionId: string, terminalId: string): TerminalOutputResponse {
    const running = this.#get(sessionId, terminalId);
    trim(running);
    const { output, truncated, exit } = running;
    return { output, truncated, ...(exit ? { exitStatus: exit } : {}) };
  }

  waitForExit(sessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    return this.#get(sessionId, terminalId).exited;
  }

  kill(sessionId: string, terminalId: string): Record<string, never> {
    const { child, exit } = this.#get(sessionId, terminalId);
    if (exit) return {};
    signal(child, "SIGTERM");
    const force = setTimeout(() => signal(child, "SIGKILL"), KILL_GRACE_MS).unref();
    child.once("exit", () => clearTimeout(force));
    return {};
  }

  release(sessionId: string, terminalId: string): Record<string, never> {
    this.kill(sessionId, terminalId);
    this.#all.delete(terminalId);
    this.#report(sessionId, terminalId, undefined);
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

  /** Resolves when the command exits, once its output is in or a moment has passed for it. */
  #exited(terminalId: string, child: ChildProcess, running: () => Running) {
    return new Promise<TerminalExitStatus>((resolve) => {
      const end = (exit: TerminalExitStatus) => {
        const state = running();
        state.exit ??= exit;
        resolve(state.exit);
      };
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.once("exit", (exitCode, signalName) => {
        const drained = new Promise((done) => setTimeout(done, DRAIN_MS).unref());
        const finish = () => end({ exitCode, signal: signalName });
        void Promise.race([closed, drained]).then(finish, finish);
      });
      child.once("error", (error) => {
        this.#append(terminalId, running(), `${error.message}\n`);
        end({ exitCode: null, signal: null });
      });
    });
  }

  #append(terminalId: string, running: Running, text: string) {
    running.output += text;
    running.bytes += Buffer.byteLength(text);
    // Trimming copies what is kept, so it waits until twice the limit has piled up.
    if (running.bytes > 2 * running.limit) trim(running);
    if (running.reporting) return;
    running.reporting = true;
    setImmediate(() => {
      running.reporting = false;
      if (!this.#all.has(terminalId)) return;
      trim(running);
      this.#report(running.sessionId, terminalId, running.output);
    });
  }
}
