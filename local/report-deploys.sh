#!/usr/bin/env bash
# Sends Foundry's recent deploy runs to the wallpaper, every minute (launchd). It reads GitHub
# Actions with your own `gh` login, the same source as your command centre, so no new token.
# Only run number, state, short commit, title and times are sent.
#
#   ./report-deploys.sh          send now
#   ./report-deploys.sh --debug  print what it would send
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
STATE="$HOME/.foundry-drafter"
# shellcheck disable=SC1091
source "$STATE/env" 2>/dev/null || { echo "No $STATE/env yet"; exit 1; }
LOG="$STATE/drafter.log"
REPO="${DEPLOY_REPO:-Git-Dann/docs-by-gitwork}"
WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"

command -v gh >/dev/null || { echo "[$(date '+%F %T')] deploys: gh isn't installed (brew install gh, then gh auth login)" >> "$LOG"; exit 1; }
RUNS="$(gh api -H "Accept: application/vnd.github+json" "repos/$REPO/actions/workflows/$WORKFLOW/runs?branch=main&per_page=20" \
  --jq '[.workflow_runs[] | {n: .run_number, status, conclusion, sha: .head_sha[0:7], title: .display_title, started: .run_started_at, updated: .updated_at, url: .html_url}]' 2>>"$LOG")" \
  || { echo "[$(date '+%F %T')] deploys: gh couldn't read $REPO (run: gh auth status)" >> "$LOG"; exit 1; }
BODY="$(jq -cn --arg repo "$REPO" --argjson runs "$RUNS" '{repo: $repo, runs: $runs}')"

if [[ "${1:-}" == "--debug" ]]; then jq '{repo, runs: (.runs[:5])}' <<<"$BODY"; exit 0; fi
while read -r link; do
  [[ "$link" == https://*"?k="* ]] || continue
  base="${link%%\?*}"; base="${base%/}"; key="${link#*\?k=}"
  curl -fsS -m 15 -X PUT -H 'content-type: application/json' --data "$BODY" "$base/api/deploys?k=$key" >/dev/null || echo "[$(date '+%F %T')] deploys: couldn't reach $base" >> "$LOG"
done <<<"${WALLPAPERS:-}"
