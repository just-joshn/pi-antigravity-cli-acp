"""Opt-in probe: which ACP features does the real `agy acp` use when a client offers them?

Speaks raw ACP to `agy acp`, advertising what Zed advertises (files, terminals, elicitation,
plans, subagents), and runs prompts meant to need each feature. For every prompt it prints the
agent's requests to the client and the kinds of session updates it sent. Uses your sign-in and
normal quota; sessions go to ~/.gemini/antigravity-scratch, away from your agy history.

    python3 tests/live-probe.py                  # gemini-3.8-flash at thinking level low
    ACP_LIVE_MODEL=gemini-4-hydrogen python3 tests/live-probe.py
"""
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

MODEL = os.environ.get("ACP_LIVE_MODEL", "gemini-3.8-flash")
CAPABILITIES = {
    "fs": {"readTextFile": True, "writeTextFile": True},
    "terminal": True,
    "elicitation": {"form": {}, "url": {}},
    "plan": {},
    "subagents": {},
}
PROMPTS = [
    ("shell command", "Run the shell command `echo PROBE-OK` and tell me its exact output."),
    ("file read", "Read probe.txt in the current directory and reply with its contents."),
    ("file edit", "Append a line containing EDITED to probe.txt in the current directory."),
    ("question", "Before doing anything, ask me which color I prefer, red or blue, using a structured question if you can. Then say the color."),
    ("plan mode", "/plan Create a file named plan.txt containing the word PLANNED."),
    ("subagent", "Use a subagent to find which files in the current directory contain the word EDITED, then report them."),
]


class Agent:
    """`agy acp` over stdio, answering its requests the way a cooperative client would.

    What it records is replaced, never edited, as the reader thread and the main loop both see it.
    """

    def __init__(self, cwd: Path):
        self.cwd = cwd
        self.proc = subprocess.Popen(
            ["agy", "acp", "--app-data-dir", "antigravity-scratch"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=cwd,
        )
        self.lock = threading.Lock()
        self.replies = {}
        self.terminals = {}
        self.forget()
        threading.Thread(target=self._read, daemon=True).start()

    def forget(self):
        """Starts recording afresh, for the next prompt."""
        self.requests = {}
        self.updates = {}
        self.samples = ()

    def _note(self, sample):
        self.samples = (*self.samples, sample)

    def _send(self, payload):
        with self.lock:
            self.proc.stdin.write(json.dumps(payload) + "\n")
            self.proc.stdin.flush()

    def _read(self):
        for line in self.proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._note(f"non-JSON line: {line[:200]!r}")
                continue
            method = message.get("method")
            if method == "session/update":
                update = message["params"]["update"]
                kind = update["sessionUpdate"]
                self.updates = {**self.updates, kind: self.updates.get(kind, 0) + 1}
                if kind in ("plan", "subagent_update") or "terminal" in json.dumps(update.get("content", "")):
                    self._note(json.dumps(update)[:300])
            elif method and "id" in message:
                self.requests = {**self.requests, method: self.requests.get(method, 0) + 1}
                self._note(f"{method} {json.dumps(message.get('params'))[:300]}")
                self._send({"jsonrpc": "2.0", "id": message["id"], **self._reply(method, message.get("params") or {})})
            elif "id" in message:
                self.replies = {**self.replies, message["id"]: message}

    def _reply(self, method, params):
        """The answer to a request; a probe failure is sent back as an error and shown, not lost."""
        try:
            return self._answer(method, params)
        except Exception as error:  # the probe reports every failure instead of stopping its reader
            self._note(f"{method} failed in the probe: {error!r}")
            return {"error": {"code": -32603, "message": f"probe failure: {error}"}}

    def _answer(self, method, params):
        if method == "session/request_permission":
            allow = next(o for o in params["options"] if o["kind"].startswith("allow"))
            return {"result": {"outcome": {"outcome": "selected", "optionId": allow["optionId"]}}}
        if method == "fs/read_text_file":
            return {"result": {"content": Path(params["path"]).read_text()}}
        if method == "fs/write_text_file":
            Path(params["path"]).write_text(params["content"])
            return {"result": {}}
        if method == "terminal/create":
            run = subprocess.run([params["command"], *params.get("args", [])], cwd=params.get("cwd") or self.cwd, capture_output=True, text=True)
            terminal_id = f"t{len(self.terminals) + 1}"
            self.terminals = {**self.terminals, terminal_id: run}
            return {"result": {"terminalId": terminal_id}}
        if method in ("terminal/output", "terminal/wait_for_exit"):
            run = self.terminals[params["terminalId"]]
            status = {"exitCode": run.returncode, "signal": None}
            if method == "terminal/wait_for_exit":
                return {"result": status}
            return {"result": {"output": run.stdout + run.stderr, "truncated": False, "exitStatus": status}}
        if method in ("terminal/kill", "terminal/release"):
            return {"result": {}}
        if method == "elicitation/create":
            return {"result": {"action": "accept", "content": {"color": "blue"}}}
        return {"error": {"code": -32601, "message": "not handled by the probe"}}

    def call(self, request_id, method, params, wait=300):
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        end = time.monotonic() + wait
        while time.monotonic() < end:
            if request_id in self.replies:
                reply = self.replies[request_id]
                self.replies = {k: v for k, v in self.replies.items() if k != request_id}
                return reply
            time.sleep(0.05)
        raise TimeoutError(method)


def main():
    with tempfile.TemporaryDirectory(prefix="agy-probe-") as temp:
        cwd = Path(temp).resolve()
        (cwd / "probe.txt").write_text("alpha\n")
        agent = Agent(cwd)
        hello = agent.call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": CAPABILITIES, "clientInfo": {"name": "pi-probe", "version": "0"}})
        print("agent:", hello["result"].get("agentInfo"))
        session = agent.call(2, "session/new", {"cwd": str(cwd), "mcpServers": []})["result"]["sessionId"]
        agent.call(3, "session/set_config_option", {"sessionId": session, "configId": "model", "value": MODEL})
        agent.call(4, "session/set_config_option", {"sessionId": session, "configId": "thought_level", "value": "low"})
        for number, (name, text) in enumerate(PROMPTS, start=10):
            agent.forget()
            reply = agent.call(number, "session/prompt", {"sessionId": session, "prompt": [{"type": "text", "text": text}]})
            print(f"\n== {name}: {reply.get('result', reply.get('error'))}")
            print("   client requests:", dict(agent.requests) or "none")
            print("   update kinds:   ", dict(agent.updates))
            for sample in agent.samples[:6]:
                print("   ", sample)
        agent.proc.kill()


if __name__ == "__main__":
    main()
