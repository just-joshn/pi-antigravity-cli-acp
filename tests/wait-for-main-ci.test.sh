#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export FIXTURE="$work" PATH="$work:$PATH"
export GH_REPO=example/test GITHUB_SHA=1234567890123456789012345678901234567890

cat > "$work/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "api --method GET repos/example/test/actions/workflows/ci.yml/runs -f branch=main -f event=push -f head_sha=$GITHUB_SHA -F per_page=1" ]]
if [[ -f "$FIXTURE/next" ]]; then
  cat "$FIXTURE/first"
  mv "$FIXTURE/next" "$FIXTURE/first"
else
  cat "$FIXTURE/first"
fi
MOCK
cat > "$work/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$work/gh" "$work/sleep"

result() {
  jq -cn --arg head "${3:-$GITHUB_SHA}" --arg status "$1" --arg conclusion "$2" \
    '{workflow_runs:[{event:"push",head_branch:"main",head_sha:$head,status:$status,conclusion:$conclusion}]}'
}

run() { bash "$root/scripts/wait-for-main-ci.sh" > "$work/log" 2>&1; }
refuses() {
  if run; then echo "CI gate accepted: $1" >&2; exit 1; fi
}
printf '{"workflow_runs":[]}\n' > "$work/first"
result completed success > "$work/next"
run
grep -F "CI passed for $GITHUB_SHA" "$work/log" > /dev/null

result in_progress "" > "$work/first"
result completed success > "$work/next"
run
grep -F "CI passed for $GITHUB_SHA" "$work/log" > /dev/null

for failure in failure cancelled; do
  result completed "$failure" > "$work/first"
  refuses "$failure"
  grep -F "CI did not pass" "$work/log" > /dev/null
done

result completed success 0000000000000000000000000000000000000000 > "$work/first"
refuses "successful CI on a different revision"

printf '{"workflow_runs":[]}\n' > "$work/first"
refuses "no CI"
grep -F "No completed main CI run" "$work/log" > /dev/null

printf 'CI release gate tests passed.\n'
