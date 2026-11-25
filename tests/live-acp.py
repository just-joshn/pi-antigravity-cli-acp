"""Opt-in live check of the Antigravity ACP provider in real Pi (RPC mode).

Uses the installed pi and Antigravity agent, your sign-in and normal quota.
With the default agent (`agy acp`) the agent's sessions go to a separate data
directory, ~/.gemini/antigravity-scratch, so they stay out of your agy history.

    python3 tests/live-acp.py            # agy acp
    python3 tests/live-acp.py registry   # the agent Zed installed from the ACP registry
"""
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[1] / "src" / "index.ts"
PROVIDER = "antigravity"
TOOL = "antigravity_tool"
AGENT = sys.argv[1] if len(sys.argv) > 1 else "cli"
EDIT_MODE = {"cli": "accept-edits", "registry": "auto_edit"}[AGENT]


class Rpc:
    """Pi in RPC mode: sends commands, answers dialogs and waits for events."""

    def __init__(self, pipe):
        self.pipe = pipe
        self.pending = queue.Queue()
        self.answers = []  # labels to pick for upcoming permission dialogs
        self.asked = []  # (title, options) of every dialog shown
        self.statuses = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.pipe.stdout:
            self.pending.put(json.loads(line))
        self.pending.put(None)

    def send(self, payload):
        self.pipe.stdin.write(json.dumps(payload) + "\n")
        self.pipe.stdin.flush()

    def until(self, matches, timeout=200):
        end = time.monotonic() + timeout
        events = []
        while True:
            e = self.pending.get(timeout=max(0.1, end - time.monotonic()))
            if e is None:
                raise RuntimeError("Pi closed stdout unexpectedly")
            events.append(e)
            if e.get("type") == "extension_ui_request":
                if e.get("method") == "select":
                    self.asked.append((e.get("title", ""), e.get("options", [])))
                    choice = self.answers.pop(0) if self.answers else None
                    reply = {"value": choice} if choice else {"cancelled": True}
                    self.send({"type": "extension_ui_response", "id": e["id"], **reply})
                elif e.get("method") == "setStatus":
                    self.statuses.append(e.get("statusText") or e.get("text") or "")
                continue
            if e.get("type") == "response" and not e.get("success"):
                raise RuntimeError(f"Pi RPC {e.get('command')} failed: {e.get('error')}")
            if matches(e):
                return events

    def request(self, command, **fields):
        self.send({"type": command, "id": command, **fields})
        return self.until(lambda e: e.get("type") == "response" and e.get("id") == command)[-1].get("data")

    def turn(self, text):
        self.send({"type": "prompt", "id": "prompt", "message": text})
        events = self.until(lambda e: e.get("type") == "agent_end")
        messages = self.request("get_messages")["messages"]
        last = messages[-1]
        assert last["role"] == "assistant" and last["provider"] == PROVIDER, last.get("provider")
        said = "".join(c["text"] for c in last["content"] if c["type"] == "text")
        return events, messages, last, said


def ok(text):
    print("PASS:", text, flush=True)


def check(pipe, work):
    rpc = Rpc(pipe)
    send, until, request, turn = rpc.send, rpc.until, rpc.request, rpc.turn
    answers, asked, statuses = rpc.answers, rpc.asked, rpc.statuses

    def models():
        return [m["id"] for m in request("get_available_models")["models"] if m["provider"] == PROVIDER]

    assert "default" in models(), "the antigravity provider is not registered"
    request("set_model", provider=PROVIDER, modelId="default")
    _, _, last, said = turn("hello, how are you doing?")
    assert last["stopReason"] == "stop" and said.strip(), last.get("errorMessage")
    ok(f"greeting answered through the agent's own model: {said.strip()[:70]!r}")

    offered = [m for m in models() if m != "default"]
    assert offered, "the agent's models did not reach Pi's model list"
    model = os.environ.get("ACP_LIVE_MODEL") or next((m for m in offered if "flash" in m), offered[0])
    request("set_model", provider=PROVIDER, modelId=model)
    request("set_thinking_level", level="low")
    ok(f"Pi's model list now offers {offered}; selected {model} at thinking level low")

    _, _, last, said = turn(
        "i was wondering what an agent harness is? And if you know what agent harness I am using right now? "
        "Answer in at most 4 sentences."
    )
    assert last["model"] == model and last.get("providerThinkingLevel") == "low", (last["model"], last.get("providerThinkingLevel"))
    # The agent describes its own harness; nothing Pi sends tells it otherwise. The agent does see
    # the workspace path and its data directory, which is why both have neutral names here.
    assert "antigravity" in said.lower() and not re.search(r"\bpi\b", said, re.IGNORECASE), said
    ok(f"harness question -> {said.strip()!r}")

    marker = "garden-" + secrets.token_hex(6)
    (work / "marker.txt").write_text(marker + "\n")
    asked.clear()
    events, messages, last, said = turn("Read marker.txt in the current directory and reply with MARKER= followed by its exact contents.")
    started = [e for e in events if e.get("type") == "tool_execution_start"]
    assert started and all(e["toolName"] == TOOL for e in started), [e.get("toolName") for e in started]
    assert marker in said and not asked, (said, asked)
    ok(f"the agent's read shows as a Pi tool row {started[0]['args']} and the answer has the unseen marker")

    answers.append("Allow")
    (work / "notes.txt").write_text("alpha\n")
    events, _, last, said = turn("Use your file editing tool, not a shell command, to append one new line containing exactly DELTA to notes.txt in the current directory. Then reply DONE.")
    assert asked and "Allow" in asked[-1][1] and "Deny" in asked[-1][1], asked
    assert "DELTA" in (work / "notes.txt").read_text(), (work / "notes.txt").read_text()
    ok(f"permission dialog {asked[-1][0]!r} {asked[-1][1]} -> Allow -> notes.txt was edited")

    asked.clear()
    answers.append("Deny")
    events, messages, last, said = turn("Run the shell command: touch denied.txt")
    assert asked, "no permission dialog for a shell command"
    assert not (work / "denied.txt").exists()
    results = [m for m in messages if m["role"] == "toolResult"]
    assert results[-1]["isError"] and "Permission declined" in str(results[-1]["content"]), results[-1]
    assert not request("get_state")["isStreaming"]
    ok(f"Deny on {asked[-1][0]!r} -> nothing ran, the tool row says declined, Pi is idle")

    (work / "marker.txt").unlink()
    events, _, _, said = turn("Without using any tools, what was the MARKER value?")
    assert marker in said and not any(e.get("type") == "tool_execution_start" for e in events), said
    ok("follow-up recalled the marker in the same agent conversation")

    asked.clear()
    send({"type": "prompt", "id": "mode", "message": f"/agy mode {EDIT_MODE}"})
    until(lambda e: e.get("type") == "response" and e.get("id") == "mode")
    events, _, _, said = turn("Use your file editing tool, not a shell command, to append one new line containing exactly ECHO to notes.txt. Then reply DONE.")
    assert "ECHO" in (work / "notes.txt").read_text() and not asked, (asked, (work / "notes.txt").read_text())
    ok(f"/agy mode {EDIT_MODE} -> the next edit ran without a permission dialog")

    stats = request("get_session_stats")
    usage = stats.get("contextUsage") or {}
    assert (usage.get("tokens") or 0) > 0, stats
    ok(f"Pi's context meter shows the agent's usage: {usage.get('tokens')} of {usage.get('contextWindow')} tokens")

    send({"type": "prompt", "id": "prompt", "message": "Write a detailed 1500-word essay on how a garden changes through the seasons. No tools."})
    until(lambda e: e.get("type") == "message_update" and e.get("assistantMessageEvent", {}).get("type") == "text_delta", timeout=90)
    request("abort")
    deadline = time.monotonic() + 30
    while request("get_state")["isStreaming"]:
        assert time.monotonic() < deadline, "Pi was still streaming 30 seconds after abort"
        time.sleep(0.2)
    aborted = request("get_messages")["messages"][-1]
    assert aborted["stopReason"] == "aborted"
    _, _, last, said = turn("Reply with exactly: STILL HERE")
    assert "STILL HERE" in said, said
    # responseId is "<agent session>/<turn>.<part>": the agent confirmed the cancel, so its session lives on.
    assert aborted["responseId"].split("/")[0] == last["responseId"].split("/")[0], (aborted["responseId"], last["responseId"])
    ok("abort stopped a streaming reply and the next prompt was answered by the same agent session")

    events, messages, last, said = turn("/agy compact")
    asked_for = [m for m in messages if m["role"] == "user"][-1]["content"]
    assert asked_for in ("/compact", [{"type": "text", "text": "/compact"}]), asked_for
    assert last["stopReason"] == "stop", last.get("errorMessage")
    ok(f"/agy compact ran the agent's own /compact as a prompt: {said.strip()[:70]!r}")
    print("status line updates seen:", sorted(set(s for s in statuses if s)), flush=True)


def restore(start):
    """Quits Pi and reopens its saved session: the agent conversation continues where it was."""
    word = "pelican-" + secrets.token_hex(4)
    first = Rpc(start([]))
    first.request("set_model", provider=PROVIDER, modelId="default")
    _, _, before, _ = first.turn(f"Remember the code word {word}. Reply only: noted")
    first.pipe.stdin.close()
    first.pipe.wait(timeout=30)
    again = Rpc(start(["--continue"]))
    _, _, after, said = again.turn("What was the code word? Reply with just the word.")
    again.pipe.stdin.close()
    again.pipe.wait(timeout=30)
    agent_session = before["responseId"].split("/")[0]
    assert word in said.lower(), said
    assert after["responseId"].startswith(agent_session + "/"), (before["responseId"], after["responseId"])
    ok(f"after restarting Pi, --continue reopened agent session {agent_session} and it recalled {word}")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="workspace-") as temp:
        root = Path(temp).resolve()
        work, tools = root / "project", root / "bin"
        work.mkdir()
        tools.mkdir()
        env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME") if k in os.environ}
        env["PI_CODING_AGENT_DIR"] = str(root / "pi")
        if AGENT == "cli":
            real = shutil.which("agy")
            assert real, "agy is not on PATH"
            shim = tools / "agy"
            shim.write_text(f'#!/bin/sh\nexec "{real}" "$@" --app-data-dir antigravity-scratch\n')
            shim.chmod(0o755)
            env["PATH"] = f"{tools}{os.pathsep}{env['PATH']}"
        base = ["pi", "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-mcp", "--no-prompt-templates", "--no-themes", "-e", str(ENTRY), "--agy-agent", AGENT]

        def start(extra):
            command = [*base, *extra]
            return subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

        pi = start(["--no-session"])
        try:
            check(pi, work)
        finally:
            pi.stdin.close()
            try:
                pi.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pi.kill()
                pi.wait()
        restore(lambda extra: start(["--session-dir", str(root / "sessions"), *extra]))
