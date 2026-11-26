#!/usr/bin/env bash
# Packs this extension, installs the tarball's contents with `pi install` into a scratch Pi, and drives it
# with the scripted agent from tests/support/fake-agy.ts: activation, a prompt, reopening the
# saved session after Pi restarts, and that no agent process outlives Pi. Uses no Antigravity
# account or quota.
#
# Pi installs `npm:` sources by registry name (it looks for node_modules/<name from the spec>), so
# an unpublished tarball cannot be installed that way. The script unpacks the tarball, installs its
# production dependencies the way Pi does for npm sources (no peers), then adds the directory with
# `pi install <path>`.
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
# The trailing argument marks this run's agent processes for the check at the end.
printf '#!/bin/sh\nexec "%s" "%s" "$@" "%s"\n' "$(command -v node)" "$repo/tests/support/fake-agy.ts" "$scratch" >"$scratch/bin/agy"
chmod +x "$scratch/bin/agy"
export PATH="$scratch/bin:$PATH"

fail() {
  echo "FAIL: $1"
  for log in "$scratch"/log-*.json; do [ -f "$log" ] && { echo "--- $log"; cat "$log"; echo; }; done
  exit 1
}

echo "== install"
# What Pi does for an npm source, without a registry: the published files, their production
# dependencies, and no peer dependencies (Pi supplies its own packages to extensions).
mkdir "$scratch/package"
tar -xzf "$tarball" -C "$scratch/package" --strip-components 1
(cd "$scratch/package" && npm install --silent --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund)
pi install "$scratch/package"
pi list | grep -q "$scratch/package" || fail "pi list does not show the package"

cd "$scratch/work"
run() {
  FAKE_AGY_LOG="$scratch/log-$1.json" pi --offline --session-dir "$scratch/sessions" \
    --model antigravity/default "${@:2}"
}

echo "== activate and prompt"
reply="$(run 1 -p "hello")"
[ "$reply" = "echo: hello" ] || fail "expected 'echo: hello', got '$reply'"

echo "== restart Pi and continue the saved session"
reply="$(run 2 -c -p "again")"
[ "$reply" = "echo: again" ] || fail "expected 'echo: again', got '$reply'"
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
' "$scratch/log-2.json" || fail "the restart did not continue the saved agent session"

echo "== shutdown"
# The scripted agent writes its log as its process exits, so wait a moment for the process to go.
[ -s "$scratch/log-1.json" ] && [ -s "$scratch/log-2.json" ] || fail "an agent did not exit"
for _ in $(seq 50); do pgrep -f "$scratch" >/dev/null || break; sleep 0.1; done
if pgrep -f "$scratch" >/dev/null; then fail "an agent process outlived Pi"; fi

echo "PASS: packed, installed with pi install, prompted, reopened after restart, no agent left running"
