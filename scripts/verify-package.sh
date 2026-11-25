#!/usr/bin/env bash
# Packs this extension, installs the tarball's contents with `pi install` into a scratch Pi, and drives it
# with the scripted agent from tests/support/fake-agy.ts: activation, a prompt, reopening the
# saved session after Pi restarts, and shutdown. Uses no Antigravity account or quota.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/work"

echo "== pack"
npm pack --silent --pack-destination "$scratch" >/dev/null
tarball="$(ls "$scratch"/pi-antigravity-acp-*.tgz)"

export HOME="$scratch"
export PI_CODING_AGENT_DIR="$scratch/agent"
export FAKE_AGY_STORE="$scratch/agy-sessions.json"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$repo/tests/support/fake-agy.ts" >"$scratch/bin/agy"
chmod +x "$scratch/bin/agy"
export PATH="$scratch/bin:$PATH"

echo "== install"
# What Pi does for an npm source, without a registry: the published files, their production
# dependencies, and no peer dependencies (Pi supplies its own packages to extensions).
mkdir "$scratch/package"
tar -xzf "$tarball" -C "$scratch/package" --strip-components 1
(cd "$scratch/package" && npm install --silent --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund)
pi install "$scratch/package"
pi list | grep -q "$scratch/package" || { echo "FAIL: pi list does not show the package"; exit 1; }

cd "$scratch/work"
run() {
  FAKE_AGY_LOG="$scratch/log-$1.json" pi --offline --session-dir "$scratch/sessions" \
    --model antigravity/default "${@:2}"
}

echo "== activate and prompt"
reply="$(run 1 -p "hello")"
[ "$reply" = "echo: hello" ] || { echo "FAIL: expected 'echo: hello', got '$reply'"; exit 1; }

echo "== restart Pi and continue the saved session"
reply="$(run 2 -c -p "again")"
[ "$reply" = "echo: again" ] || { echo "FAIL: expected 'echo: again', got '$reply'"; exit 1; }
node -e '
  const log = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (log.sessions.length !== 0 || log.loads.length !== 1) {
    console.error("FAIL: the agent session was not reopened", log.loads, log.sessions.length);
    process.exit(1);
  }
  const sent = log.prompts.flat().map((block) => `${block.type}:${block.text}`);
  if (sent.join() !== "text:again") {
    console.error("FAIL: history was resent", JSON.stringify(log.prompts));
    process.exit(1);
  }
' "$scratch/log-2.json"

echo "== shutdown"
# The scripted agent writes its log only when its process exits; both logs exist, so both exited.
[ -s "$scratch/log-1.json" ] && [ -s "$scratch/log-2.json" ] || { echo "FAIL: agent still running"; exit 1; }
if pgrep -f "$repo/tests/support/fake-agy.ts" >/dev/null; then
  echo "FAIL: an agent process outlived Pi"
  exit 1
fi

echo "PASS: packed, installed with pi install, prompted, reopened after restart, shut down"
