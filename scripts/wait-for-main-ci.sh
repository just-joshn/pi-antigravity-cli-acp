#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO must be set}"
: "${GITHUB_SHA:?GITHUB_SHA must be set}"
endpoint="repos/$GH_REPO/actions/workflows/ci.yml/runs"
for ((attempt = 0; attempt < 100; attempt++)); do
  runs=$(gh api --method GET "$endpoint" -f branch=main -f event=push -f "head_sha=$GITHUB_SHA" -F per_page=1)
  run=$(jq -c '.workflow_runs | arrays | .[0]' <<< "$runs")
  if [[ $run != null ]]; then
    status=$(jq -er --arg sha "$GITHUB_SHA" '
      select(.head_sha == $sha and .head_branch == "main" and .event == "push") | .status
    ' <<< "$run")
    if [[ $status == completed ]]; then
      if jq -e '.conclusion == "success"' <<< "$run" > /dev/null; then
        echo "CI passed for $GITHUB_SHA."
        exit 0
      fi
      echo "CI did not pass for $GITHUB_SHA. Rerun CI before retrying staging." >&2
      exit 1
    fi
  fi
  sleep 15
done
echo "No completed main CI run for $GITHUB_SHA within 25 minutes." >&2
exit 1
