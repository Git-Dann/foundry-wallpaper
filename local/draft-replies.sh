#!/usr/bin/env bash
# Foundry drafter: runs your own Claude Code on this Mac, drafts replies to emails and Slack
# messages that are waiting on you, and tells the wallpaper what it drafted.
#
# It only ever creates DRAFTS. Sending, replying, forwarding and posting tools are not allowed,
# and every other tool is denied because `claude -p` refuses anything not on the allow-list.
#
#   ./draft-replies.sh --check    list your MCP servers and the tool names this script will use
#   ./draft-replies.sh            one run now
#   ./draft-replies.sh --install  run it hourly on weekdays, 07:00–19:00 (launchd)
#
# Config lives in ~/.foundry-drafter/env (created on first run):
#   WALLPAPERS                          where to report drafts: one "<url>?k=<key>" per line
#   GMAIL_MCP, SLACK_MCP, FOUNDRY_MCP, CALENDAR_MCP   the MCP server names `claude mcp list` shows
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.foundry-drafter"
ENV_FILE="$STATE_DIR/env"
DONE_FILE="$STATE_DIR/drafted.txt"
LOG="$STATE_DIR/drafter.log"
mkdir -p "$STATE_DIR"
touch "$DONE_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Every wallpaper to report drafts to: paste each full wallpaper link, one per line.
# (One for the Gitwork Cloudflare account, one for your personal one, or just one.)
WALLPAPERS="
"
# MCP server names as `claude mcp list` shows them. claude.ai connectors usually appear
# as claude_ai_<Name>; check with ./draft-replies.sh --check and fix these if they differ.
GMAIL_MCP="claude_ai_Gmail"
SLACK_MCP="claude_ai_Slack"
FOUNDRY_MCP="claude_ai_Foundry"
CALENDAR_MCP="claude_ai_Google_Calendar"
# Model for drafting. Sonnet is plenty for replies and far cheaper than the default.
MODEL="sonnet"
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Paste your wallpaper link(s), check the server names, then run again."
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

tools_for() {
  local server="$1"; shift
  for t in "$@"; do printf 'mcp__%s__%s\n' "$server" "$t"; done
}

ALLOWED=(
  $(tools_for "$GMAIL_MCP" search_threads get_thread get_message list_drafts get_draft create_draft)
  $(tools_for "$SLACK_MCP" slack_search_public_and_private slack_read_thread slack_read_channel slack_read_user_profile slack_search_users slack_send_message_draft)
  $(tools_for "$FOUNDRY_MCP" whoami list_clients get_client list_tasks get_task find_meetings list_wiki get_wiki_page list_documents list_conversations)
  $(tools_for "$CALENDAR_MCP" list_events search_events get_event)
)
# Belt and braces: name the dangerous ones explicitly too.
DENIED=(
  Bash Write Edit NotebookEdit WebFetch
  $(tools_for "$GMAIL_MCP" send_message reply forward trash_message trash_thread delete_draft update_draft)
  $(tools_for "$SLACK_MCP" slack_send_message slack_schedule_message slack_create_canvas slack_update_canvas)
)

case "${1:-}" in
  --check)
    claude mcp list
    echo
    echo "Allowed tools (first of each server; all must exist in the list above):"
    printf '  %s\n' "${ALLOWED[@]}"
    exit 0 ;;
  --install)
    PLIST="$HOME/Library/LaunchAgents/uk.co.gitwork.foundry-drafter.plist"
    sed "s#__SCRIPT__#$HERE/draft-replies.sh#; s#__LOG__#$LOG#" "$HERE/uk.co.gitwork.foundry-drafter.plist" > "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed. It runs hourly on weekdays, 07:00–19:00. Log: $LOG"
    exit 0 ;;
  --scheduled)
    dow=$(date +%u); hr=$(date +%H)
    if (( dow > 5 || 10#$hr < 7 || 10#$hr >= 19 )); then exit 0; fi ;;
esac

TARGETS=(); while read -r line; do [[ "$line" == https://*"?k="* ]] && TARGETS+=("$line"); done <<<"${WALLPAPERS:-}"
(( ${#TARGETS[@]} )) || { echo "Add at least one wallpaper link (https://…?k=…) to WALLPAPERS in $ENV_FILE"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code isn't installed (npm i -g @anthropic-ai/claude-code)"; exit 1; }
command -v jq >/dev/null || { echo "jq is needed (brew install jq)"; exit 1; }

PROMPT="$(cat "$HERE/prompt.md")

## Already drafted (skip these refs)
$(tail -n 200 "$DONE_FILE")

Today is $(date '+%A %d %B %Y, %H:%M %Z')."

echo "[$(date '+%F %T')] run started" >> "$LOG"
RESULT="$(claude -p "$PROMPT" \
  --output-format json \
  --model "${MODEL:-sonnet}" \
  --json-schema "$(cat "$HERE/draft-schema.json")" \
  --allowedTools "${ALLOWED[@]}" \
  --disallowedTools "${DENIED[@]}" 2>>"$LOG")" || { echo "[$(date '+%F %T')] claude failed" >> "$LOG"; exit 1; }

# --output-format json wraps the run; the structured answer is in .structured_output (or .result as text).
REPORT="$(jq -c '.structured_output // (.result | fromjson? ) // empty' <<<"$RESULT")"
[[ -n "$REPORT" ]] || { echo "[$(date '+%F %T')] no report in output" >> "$LOG"; echo "$RESULT" >> "$LOG"; exit 1; }

jq -r '.drafts[]?.ref // empty' <<<"$REPORT" >> "$DONE_FILE"
for link in "${TARGETS[@]}"; do
  base="${link%%\?*}"; key="${link#*\?k=}"; base="${base%/}"
  # One wallpaper being down mustn't lose the report for the others.
  curl -fsS -X PUT -H 'content-type: application/json' --data "$REPORT" "$base/api/drafts?k=$key" >> "$LOG" \
    || echo " [$(date '+%F %T')] couldn't reach $base" >> "$LOG"
done
echo " [$(date '+%F %T')] $(jq '.drafts | length' <<<"$REPORT") drafts reported" >> "$LOG"
jq '.' <<<"$REPORT"
