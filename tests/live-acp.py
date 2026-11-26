"""Opt-in live check of the Antigravity ACP provider in real Pi (RPC mode).

Uses the installed pi and Antigravity agent, your sign-in and normal quota.
With the default agent (`agy acp`) the agent's sessions go to a separate data
directory, ~/.gemini/antigravity-scratch, so they stay out of your agy history.

    python3 tests/live-acp.py            # agy acp
    python3 tests/live-acp.py registry   # the agent Zed installed from the ACP registry
"""
import base64
import json
import os
import queue
import re
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[1] / "src" / "index.ts"
PROVIDER = "antigravity"
TOOL = "antigravity_tool"
EDIT_MODES = {"cli": "accept-edits", "registry": "auto_edit"}
AGENT = sys.argv[1] if len(sys.argv) > 1 else "cli"
if AGENT not in EDIT_MODES:
    sys.exit(f"usage: python3 tests/live-acp.py [{'|'.join(EDIT_MODES)}]")
EDIT_MODE = EDIT_MODES[AGENT]
DEFAULT_MODEL = os.environ.get("ACP_LIVE_MODEL")
PI_FLAGS = ["--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-mcp", "--no-prompt-templates", "--no-themes"]


class Rpc:
    """Pi in RPC mode: sends commands, answers dialogs and waits for events.

    What it records is kept in tuples that are replaced, never edited, as the reader thread and the
    checks both see them.
    """

    def __init__(self, pipe):
        self.pipe = pipe
        self.pending = queue.Queue()
        self.answers = ()  # labels, or functions of the offered labels, for upcoming dialogs
        self.asked = ()  # (title, options) of every dialog shown
        self.statuses = ()
        self.notes = ()  # (type, message) of every notice
        self.widgets = ()  # (key, lines) of every widget shown or cleared
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.pipe.stdout:
            try:
                self.pending.put(json.loads(line))
            except json.JSONDecodeError:
                self.pending.put({"type": "unparsed", "line": line})
        self.pending.put(None)

    def answer(self, choice):
        """Queues the answer to the next select dialog."""
        self.answers = (*self.answers, choice)

    def forget_dialogs(self):
        self.asked = ()

    def send(self, payload):
        self.pipe.stdin.write(json.dumps(payload) + "\n")
        self.pipe.stdin.flush()

    def _select(self, event):
        options = event.get("options", [])
        self.asked = (*self.asked, (event.get("title", ""), options))
        choice, *rest = self.answers or (None,)
        self.answers = tuple(rest)
        choice = choice(options) if callable(choice) else choice
        reply = {"value": choice} if choice else {"cancelled": True}
        self.send({"type": "extension_ui_response", "id": event["id"], **reply})

    def _input(self, event):
        """Answers a text dialog from the queue; an empty string submits it blank, nothing queued cancels."""
        self.asked = (*self.asked, (event.get("title", ""), []))
        choice, *rest = self.answers or (None,)
        self.answers = tuple(rest)
        reply = {"cancelled": True} if choice is None else {"value": choice}
        self.send({"type": "extension_ui_response", "id": event["id"], **reply})

    def _ui(self, event):
        method = event.get("method")
        if method == "select":
            self._select(event)
        elif method in ("input", "confirm", "editor"):
            self._input(event)
        elif method == "setStatus":
            self.statuses = (*self.statuses, event.get("statusText") or event.get("text") or "")
        elif method == "notify":
            self.notes = (*self.notes, (event.get("notifyType"), event.get("message", "")))
        elif method == "setWidget":
            self.widgets = (*self.widgets, (event.get("widgetKey"), event.get("widgetLines")))

    def until(self, matches, timeout=200):
        end = time.monotonic() + timeout
        events = ()
        while True:
            try:
                event = self.pending.get(timeout=max(0.1, end - time.monotonic()))
            except queue.Empty:
                raise TimeoutError(f"no matching event within {timeout} s; last: {events[-1:]}") from None
            if event is None:
                raise RuntimeError("Pi closed stdout unexpectedly")
            if event.get("type") == "unparsed":
                raise RuntimeError(f"Pi wrote a line that is not JSON: {event['line'][:200]!r}")
            events = (*events, event)
            if event.get("type") == "extension_ui_request":
                self._ui(event)
            elif event.get("type") == "response" and not event.get("success"):
                raise RuntimeError(f"Pi RPC {event.get('command')} failed: {event.get('error')}")
            elif matches(event):
                return events

    def request(self, command, **fields):
        self.send({"type": command, "id": command, **fields})
        return self.until(lambda e: e.get("type") == "response" and e.get("id") == command)[-1].get("data")

    def command(self, text, name):
        """Runs a slash command that does not start a turn."""
        self.send({"type": "prompt", "id": name, "message": text})
        self.until(lambda e: e.get("type") == "response" and e.get("id") == name)

    def turn(self, text, images=None):
        self.send({"type": "prompt", "id": "prompt", "message": text, **({"images": images} if images else {})})
        events = self.until(lambda e: e.get("type") == "agent_end")
        messages = self.request("get_messages")["messages"]
        last = messages[-1]
        assert last["role"] == "assistant" and last["provider"] == PROVIDER, last.get("provider")
        said = "".join(c["text"] for c in last["content"] if c["type"] == "text")
        return events, messages, last, said

    def models(self):
        return [m["id"] for m in self.request("get_available_models")["models"] if m["provider"] == PROVIDER]

    def quit(self):
        self.pipe.stdin.close()
        try:
            self.pipe.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.pipe.kill()
            self.pipe.wait()


def ok(text):
    print("PASS:", text, flush=True)


def note(text):
    print("NOTE:", text, flush=True)


def greet(rpc):
    assert "default" in rpc.models(), "the antigravity provider is not registered"
    rpc.request("set_model", provider=PROVIDER, modelId="default")
    _, _, last, said = rpc.turn("hello, how are you doing?")
    assert last["stopReason"] == "stop" and said.strip(), last.get("errorMessage")
    ok(f"greeting answered through the agent's own model: {said.strip()[:70]!r}")


def pick_model(rpc):
    offered = [m for m in rpc.models() if m != "default"]
    assert offered, "the agent's models did not reach Pi's model list"
    model = DEFAULT_MODEL or next((m for m in offered if "flash" in m), offered[0])
    rpc.request("set_model", provider=PROVIDER, modelId=model)
    rpc.request("set_thinking_level", level="low")
    ok(f"Pi's model list now offers {offered}; selected {model} at thinking level low")
    return model


def harness_question(rpc, model):
    _, _, last, said = rpc.turn(
        "i was wondering what an agent harness is? And if you know what agent harness I am using right now? "
        "Answer in at most 4 sentences."
    )
    level = last.get("providerThinkingLevel")
    assert last["model"] == model and level == "low", (last["model"], level)
    # The agent describes its own harness; nothing Pi sends tells it otherwise. The agent does see
    # the workspace path and its data directory, which is why both have neutral names here.
    assert "antigravity" in said.lower() and not re.search(r"\bpi\b", said, re.IGNORECASE), said
    ok(f"harness question -> {said.strip()!r}")


def read_marker(rpc, work):
    marker = "garden-" + secrets.token_hex(6)
    (work / "marker.txt").write_text(marker + "\n")
    rpc.forget_dialogs()
    events, _, _, said = rpc.turn("Read marker.txt in the current directory and reply with MARKER= followed by its exact contents.")
    started = [e for e in events if e.get("type") == "tool_execution_start"]
    assert started and all(e["toolName"] == TOOL for e in started), [e.get("toolName") for e in started]
    assert marker in said and not rpc.asked, (said, rpc.asked)
    ok(f"the agent's read shows as a Pi tool row {started[0]['args']} and the answer has the unseen marker")
    return marker


def allowed_edit(rpc, work):
    rpc.answer("Allow")
    (work / "notes.txt").write_text("alpha\n")
    rpc.turn("Use your file editing tool, not a shell command, to append one new line containing exactly DELTA to notes.txt in the current directory. Then reply DONE.")
    title, options = rpc.asked[-1] if rpc.asked else ("", [])
    assert "Allow" in options and "Deny" in options, rpc.asked
    assert "DELTA" in (work / "notes.txt").read_text(), (work / "notes.txt").read_text()
    ok(f"permission dialog {title!r} {options} -> Allow -> notes.txt was edited")


def denied_command(rpc, work):
    rpc.forget_dialogs()
    rpc.answer("Deny")
    _, messages, _, _ = rpc.turn("Run the shell command: touch denied.txt")
    assert rpc.asked, "no permission dialog for a shell command"
    assert not (work / "denied.txt").exists()
    results = [m for m in messages if m["role"] == "toolResult"]
    assert results[-1]["isError"] and "Permission declined" in str(results[-1]["content"]), results[-1]
    assert not rpc.request("get_state")["isStreaming"]
    ok(f"Deny on {rpc.asked[-1][0]!r} -> nothing ran, the tool row says declined, Pi is idle")


def follow_up(rpc, work, marker):
    (work / "marker.txt").unlink()
    events, _, _, said = rpc.turn("Without using any tools, what was the MARKER value?")
    assert marker in said and not any(e.get("type") == "tool_execution_start" for e in events), said
    ok("follow-up recalled the marker in the same agent conversation")


def mode_change(rpc, work):
    rpc.forget_dialogs()
    rpc.command(f"/agy mode {EDIT_MODE}", "mode")
    rpc.turn("Use your file editing tool, not a shell command, to append one new line containing exactly ECHO to notes.txt. Then reply DONE.")
    text = (work / "notes.txt").read_text()
    assert "ECHO" in text and not rpc.asked, (rpc.asked, text)
    ok(f"/agy mode {EDIT_MODE} -> the next edit ran without a permission dialog")


def context_meter(rpc):
    stats = rpc.request("get_session_stats")
    usage = stats.get("contextUsage") or {}
    assert (usage.get("tokens") or 0) > 0, stats
    ok(f"Pi's context meter shows the agent's usage: {usage.get('tokens')} of {usage.get('contextWindow')} tokens")


def abort(rpc):
    rpc.send({"type": "prompt", "id": "prompt", "message": "Write a detailed 1500-word essay on how a garden changes through the seasons. No tools."})
    rpc.until(lambda e: e.get("type") == "message_update" and e.get("assistantMessageEvent", {}).get("type") == "text_delta", timeout=90)
    rpc.request("abort")
    deadline = time.monotonic() + 30
    while rpc.request("get_state")["isStreaming"]:
        assert time.monotonic() < deadline, "Pi was still streaming 30 seconds after abort"
        time.sleep(0.2)
    aborted = rpc.request("get_messages")["messages"][-1]
    assert aborted["stopReason"] == "aborted"
    _, _, last, said = rpc.turn("Reply with exactly: STILL HERE")
    assert "STILL HERE" in said, said
    # responseId is "<agent session>/<turn>.<part>": the agent confirmed the cancel, so its session lives on.
    assert aborted["responseId"].split("/")[0] == last["responseId"].split("/")[0], (aborted["responseId"], last["responseId"])
    ok("abort stopped a streaming reply and the next prompt was answered by the same agent session")


def agent_command(rpc, text):
    """Runs `/agy <agent command>`; False, with a note, when this agent does not list the command."""
    rpc.command(text, "agent-command")
    if rpc.notes and rpc.notes[-1][1].startswith("Usage: /agy"):
        note(f"this agent lists no such command, so {text.split()[1]!r} showed the usage")
        return False
    rpc.until(lambda e: e.get("type") == "agent_end")
    return True


def compact(rpc):
    if not agent_command(rpc, "/agy compact"):
        return
    messages = rpc.request("get_messages")["messages"]
    last = messages[-1]
    said = "".join(c["text"] for c in last["content"] if c["type"] == "text")
    asked_for = [m for m in messages if m["role"] == "user"][-1]["content"]
    assert asked_for in ("/compact", [{"type": "text", "text": "/compact"}]), asked_for
    assert last["stopReason"] == "stop", last.get("errorMessage")
    ok(f"/agy compact ran the agent's own /compact as a prompt: {said.strip()[:70]!r}")


def check(rpc, work):
    greet(rpc)
    harness_question(rpc, pick_model(rpc))
    marker = read_marker(rpc, work)
    allowed_edit(rpc, work)
    denied_command(rpc, work)
    follow_up(rpc, work, marker)
    mode_change(rpc, work)
    context_meter(rpc)
    abort(rpc)
    compact(rpc)
    print("status line updates seen:", sorted(set(s for s in rpc.statuses if s)), flush=True)


def restore(start):
    """Quits Pi and reopens its saved session: the agent conversation continues where it was."""
    word = "pelican-" + secrets.token_hex(4)
    first = Rpc(start([]))
    try:
        first.request("set_model", provider=PROVIDER, modelId="default")
        _, _, before, _ = first.turn(f"Remember the code word {word}. Reply only: noted")
    finally:
        first.quit()
    again = Rpc(start(["--continue"]))
    try:
        _, _, after, said = again.turn("What was the code word? Reply with just the word.")
    except RuntimeError as error:
        model = (again.request("get_state") or {}).get("model")
        raise RuntimeError(f"{error}\nPi's model after --continue: {model}") from error
    finally:
        again.quit()
    agent_session = before["responseId"].split("/")[0]
    assert word in said.lower(), said
    assert after["responseId"].startswith(agent_session + "/"), (before["responseId"], after["responseId"])
    ok(f"after restarting Pi, --continue reopened agent session {agent_session} and it recalled {word}")


def red_png(size=32):
    """A solid red PNG, built without image libraries."""
    row = b"\x00" + b"\xff\x00\x00" * size
    pixels = zlib.compress(row * size)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    return base64.b64encode(png).decode()


def extra_directory(rpc, extra):
    marker = "harbor-" + secrets.token_hex(5)
    (extra / "marker.txt").write_text(marker + "\n")
    _, _, first, said = rpc.turn(f"Read the file marker.txt in the directory {extra} and reply with exactly its contents.")
    assert marker in said, said
    ok(f"--agy-dir {extra.name}: the agent read a file outside the workspace: {said.strip()!r}")
    return marker, first


def image(rpc):
    picture = {"type": "image", "data": red_png(), "mimeType": "image/png"}
    _, _, _, said = rpc.turn("What single color fills this image? Reply with one word.", images=[picture])
    assert "red" in said.lower(), said
    ok(f"an image attachment reached the agent: {said.strip()!r}")


def terminal_output(rpc):
    word = "TERMINAL-" + secrets.token_hex(4)
    rpc.answer("Allow")
    _, messages, _, _ = rpc.turn(f"Run the shell command `echo {word}` and then reply DONE.")
    results = [m for m in messages if m["role"] == "toolResult"]
    assert any(word in json.dumps(r["content"]) for r in results), results[-1:]
    ok(f"the command's output shows in its Pi tool row: {word}")
    thoughts = [b for m in messages if m["role"] == "assistant" for b in m["content"] if b["type"] == "thinking"]
    note(f"thinking blocks so far: {len(thoughts)}" + (f", first: {thoughts[0]['thinking'][:60]!r}" if thoughts else ""))


def title(rpc, first):
    rpc.command("/agy status", "status")
    shown = re.search(r"Agent session: (\S+)(?: \((.+)\))?$", rpc.notes[-1][1], re.MULTILINE)
    assert shown, rpc.notes[-1][1]
    agent_session, name = shown.groups()
    assert first["responseId"].startswith(agent_session + "/"), (first["responseId"], agent_session)
    if name:
        ok(f"/agy status names the agent's title for the session: {name!r}")
    else:
        note("this agent did not title the session")
    return agent_session, name


def plan(rpc):
    if not agent_command(rpc, "/agy plan Create a file named plan.txt containing the word PLANNED."):
        return
    plans = [lines for key, lines in rpc.widgets if key == "antigravity-plan" and lines]
    note(f"plan widgets shown: {len(plans)}" + (f", first: {plans[0]}" if plans else ""))


def saved_sessions(rpc, marker, agent_session, name):
    # Without a title, the session just used is the newest the agent lists.
    rpc.answer(lambda options: next(o for o in options if o.startswith(name)) if name else options[0])
    rpc.command("/agy sessions", "sessions")
    if rpc.notes and "no saved sessions" in rpc.notes[-1][1]:
        note("this agent lists no saved sessions")
        return
    _, messages, last, said = rpc.turn("What was the contents of marker.txt you read earlier? Reply with just it.")
    assert marker in said, said
    assert last["responseId"].startswith(agent_session + "/"), (last["responseId"], agent_session)
    conversation = [m for m in messages if m["role"] != "system"]
    assert conversation[0]["role"] == "user", conversation[0]["role"]
    ok(f"/agy sessions opened {name or 'the newest session'!r} as a new Pi session that continues agent session {agent_session}")


def question(rpc):
    """A structured question from the agent, answered with Pi's dialogs."""
    rpc.forget_dialogs()
    rpc.answer("Answer")
    rpc.answer(lambda options: next(o for o in options if "blue" in o.lower()))
    rpc.answer("")  # agy adds an optional free-form "Other" field, left blank
    _, _, _, said = rpc.turn("Before doing anything, ask me which color I prefer, red or blue, using a structured question if you can. Then say the color.")
    if not any("Answer" in options for _, options in rpc.asked):
        note(f"the agent asked in plain text, not with a structured question: {said.strip()[:80]!r}")
        return
    assert "blue" in said.lower(), said
    ok(f"the agent's structured question was answered in Pi's dialogs {[t for t, _ in rpc.asked]} -> {said.strip()[:60]!r}")


def features(start, root):
    """Extra directories, images, client terminals, titles, plans, thoughts and /agy sessions."""
    extra = root / "extra"
    extra.mkdir()
    rpc = Rpc(start(["--agy-dir", str(extra)]))
    try:
        pick_model(rpc)
        marker, first = extra_directory(rpc, extra)
        image(rpc)
        terminal_output(rpc)
        agent_session, name = title(rpc, first)
        plan(rpc)
        saved_sessions(rpc, marker, agent_session, name)
        question(rpc)
    finally:
        rpc.quit()


def environment(root, tools):
    """Pi's environment: a scratch agent directory, and for `agy` a shim that keeps its sessions apart."""
    inherited = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME") if k in os.environ}
    env = {**inherited, "PI_CODING_AGENT_DIR": str(root / "pi")}
    if AGENT != "cli":
        return env
    real = shutil.which("agy")
    assert real, "agy is not on PATH"
    shim = tools / "agy"
    shim.write_text(f'#!/bin/sh\nexec "{real}" "$@" --app-data-dir antigravity-scratch\n')
    shim.chmod(0o755)
    return {**env, "PATH": f"{tools}{os.pathsep}{env['PATH']}"}


def main(root):
    work, tools = root / "project", root / "bin"
    work.mkdir()
    tools.mkdir()
    env = environment(root, tools)
    base = ["pi", *PI_FLAGS, "-e", str(ENTRY), "--agy-agent", AGENT]

    def start(extra):
        command = [*base, *extra]
        return subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    rpc = Rpc(start(["--no-session"]))
    try:
        check(rpc, work)
    finally:
        rpc.quit()
    restore(lambda extra: start(["--session-dir", str(root / "sessions"), *extra]))
    features(lambda extra: start(["--session-dir", str(root / "features"), *extra]), root)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="workspace-") as temp:
        main(Path(temp).resolve())
