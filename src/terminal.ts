import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  type CreateTerminalRequest,
  RequestError,
  type TerminalExitStatus,
  type TerminalOutputResponse,
} from "@agentclientprotocol/sdk/unstable";

import { put, without } from "./immutable.ts";

/** Most output reported per terminal, whatever the agent asks for; up to twice this is held between trims. */
const OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 1000;
/** Output may grow to this many times its limit before it is trimmed, so trims copy rarely. */
const TRIM_FACTOR = 2;
/** After the command exits, how long to wait for output still held by processes it left behind. */
const DRAIN_MS = 1000;
/** Process groups let a stop reach what the command started; Windows has none to signal. */
const GROUPS = process.platform !== "win32";

type Report = (sessionId: string, terminalId: string, output: string | undefined) => void;

interface Running {
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly output: string;
  /** UTF-8 size of `output`, which may exceed `limit` until it is next trimmed. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly limit: number;
  /** An output report is scheduled; reports are coalesced so a flood of chunks costs one each. */
  readonly reporting: boolean;
  readonly exit: TerminalExitStatus | undefined;
  readonly exited: Promise<TerminalExitStatus>;
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

function trimmed(running: Running): Running {
  if (running.bytes <= running.limit) return running;
  const kept = keepEnd(running.output, running.limit);
  const bytes = Buffer.byteLength(kept.text);
  return { ...running, output: kept.text, bytes, truncated: running.truncated || kept.cut };
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
  #all: ReadonlyMap<string, Running> = new Map();
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
    const added = (request.env ?? []).map(({ name, value }): [string, string] => [name, value]);
    const env = { ...process.env, ...Object.fromEntries(added) };
    const child = spawn(request.command, request.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: GROUPS,
    });
    this.#count += 1;
    const terminalId = `pi-terminal-${this.#count}`;
    this.#all = put(this.#all, terminalId, {
      sessionId: request.sessionId,
      child,
      output: "",
      bytes: 0,
      truncated: false,
      limit: Math.max(0, Math.min(request.outputByteLimit ?? OUTPUT_LIMIT, OUTPUT_LIMIT)),
      reporting: false,
      exit: undefined,
      exited: this.#exited(terminalId, child),
    });
    // Decoding per stream keeps a character split across two chunks whole.
    const append = (text: string) => this.#append(terminalId, text);
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    return { terminalId };
  }

  output(sessionId: string, terminalId: string): TerminalOutputResponse {
    const kept = trimmed(this.#get(sessionId, terminalId));
    this.#all = put(this.#all, terminalId, kept);
    const { output, truncated, exit } = kept;
    return { output, truncated, ...(exit ? { exitStatus: exit } : {}) };
  }

  waitForExit(sessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    return this.#get(sessionId, terminalId).exited;
  }

  /** Stops the command and what it started; whatever is still running a moment later is killed. */
  kill(sessionId: string, terminalId: string): Record<string, never> {
    const { child } = this.#get(sessionId, terminalId);
    signal(child, "SIGTERM");
    setTimeout(() => signal(child, "SIGKILL"), KILL_GRACE_MS).unref();
    return {};
  }

  release(sessionId: string, terminalId: string): Record<string, never> {
    this.kill(sessionId, terminalId);
    // Output not reported yet is reported now, before the terminal is forgotten.
    if (this.#all.get(terminalId)?.reporting) this.#reportOutput(terminalId);
    this.#all = without(this.#all, terminalId);
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
  #exited(terminalId: string, child: ChildProcess) {
    return new Promise<TerminalExitStatus>((resolve) => {
      const end = (exit: TerminalExitStatus) => {
        const running = this.#all.get(terminalId);
        if (running && !running.exit) this.#all = put(this.#all, terminalId, { ...running, exit });
        resolve(running?.exit ?? exit);
      };
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.once("exit", (exitCode, signalName) => {
        const drained = new Promise((done) => setTimeout(done, DRAIN_MS).unref());
        const finish = () => end({ exitCode, signal: signalName });
        void Promise.race([closed, drained]).then(finish, finish);
      });
      child.once("error", (error) => {
        this.#append(terminalId, `${error.message}\n`);
        end({ exitCode: null, signal: null });
      });
    });
  }

  #append(terminalId: string, text: string) {
    const running = this.#all.get(terminalId);
    if (!running) return;
    const grown = {
      ...running,
      output: running.output + text,
      bytes: running.bytes + Buffer.byteLength(text),
    };
    const kept = grown.bytes > TRIM_FACTOR * grown.limit ? trimmed(grown) : grown;
    this.#all = put(this.#all, terminalId, { ...kept, reporting: true });
    if (!running.reporting) setImmediate(() => this.#reportOutput(terminalId));
  }

  /** Tells the session a terminal's output, once for all the chunks since the last report. */
  #reportOutput(terminalId: string) {
    const running = this.#all.get(terminalId);
    if (!running) return;
    const current = { ...trimmed(running), reporting: false };
    this.#all = put(this.#all, terminalId, current);
    this.#report(current.sessionId, terminalId, current.output);
  }
}
