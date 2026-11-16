#!/usr/bin/env bash
# Foundry helper: runs on your Mac and feeds the wallpaper. Two scheduled jobs, neither can send
# or change anything in Gmail, Slack or Foundry:
#
#   asks   (hourly, weekdays 07:00–19:00)  your own Claude Code reads Slack, Gmail and meeting notes
#                                          and lists what people have asked of you, with their words.
#   usage  (every 5 minutes)               sends your Claude and Codex plan usage. Doesn't call any
#                                          model, so it costs nothing.
#
#   ./draft-replies.sh            collect asks now
#   ./draft-replies.sh --usage    send usage now
#   ./draft-replies.sh --check    list your MCP servers and the tool names this script uses
#   ./draft-replies.sh --install  schedule both jobs and set up the Claude Code status line
#
# (It used to suggest replies too; that's gone. The name stays because scheduled jobs point at it.)
#
# Config lives in ~/.foundry-drafter/env (created on first run):
#   WALLPAPERS                          your wallpaper link, "<url>?k=<key>" (one per line)
#   GMAIL_MCP, SLACK_MCP, FOUNDRY_MCP, CALENDAR_MCP   the MCP server names `claude mcp list` shows
#   MEETINGS_MCP                        Meetings connector name, if you have it (default claude_ai_Meetings)
#   MODEL                               model for the asks job (default sonnet)
set -euo pipefail
# launchd starts us with a bare PATH and bash never reads ~/.zprofile, so add where Claude Code
# (native installer) and Homebrew live, or scheduled runs can't find claude or jq.
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.foundry-drafter"
ENV_FILE="$STATE_DIR/env"
LOG="$STATE_DIR/drafter.log"
mkdir -p "$STATE_DIR"

# Jobs installed by earlier versions: nothing to do any more.
case "${1:-}" in --place|--place-scheduled) exit 0 ;; esac

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Your wallpaper link (the whole thing, with ?k=). More than one: one per line.
WALLPAPERS="
"
# MCP server names as `claude mcp list` shows them. claude.ai connectors usually appear
# as claude_ai_<Name>; check with ./draft-replies.sh --check and fix these if they differ.
GMAIL_MCP="claude_ai_Gmail"
SLACK_MCP="claude_ai_Slack"
FOUNDRY_MCP="claude_ai_Foundry"
CALENDAR_MCP="claude_ai_Google_Calendar"
MEETINGS_MCP="claude_ai_Meetings"
# Model for the asks job. Sonnet is plenty and far cheaper than the default.
MODEL="sonnet"
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Paste your wallpaper link, check the server names, then run again."
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

tools_for() {
  local server="$1"; shift
  for t in "$@"; do printf 'mcp__%s__%s\n' "$server" "$t"; done
}

# Reading only.
READ_TOOLS=(
  $(tools_for "$GMAIL_MCP" search_threads get_thread get_message)
  $(tools_for "$SLACK_MCP" slack_search_public_and_private slack_read_thread slack_read_channel slack_read_user_profile slack_search_users)
  $(tools_for "$FOUNDRY_MCP" whoami list_clients get_client list_tasks get_task find_meetings)
  $(tools_for "$CALENDAR_MCP" list_events search_events get_event)
  $(tools_for "${MEETINGS_MCP:-claude_ai_Meetings}" list_meetings get_meeting get_meeting_action_items)
)
# Belt and braces: name anything that writes, too.
DENIED=(
  Bash Write Edit NotebookEdit WebFetch
  $(tools_for "$GMAIL_MCP" send_message reply forward create_draft update_draft delete_draft trash_message trash_thread)
  $(tools_for "$SLACK_MCP" slack_send_message slack_send_message_draft slack_schedule_message slack_create_canvas slack_update_canvas)
)

TARGETS=(); while read -r line; do [[ "$line" == https://*"?k="* ]] && TARGETS+=("$line"); done <<<"${WALLPAPERS:-}"
base_of() { local b="${1%%\?*}"; echo "${b%/}"; }
key_of() { echo "${1#*\?k=}"; }
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

case "${1:-}" in
  --check)
    claude mcp list
    echo
    echo "Tools this script uses (each must exist in the list above):"
    printf '  %s\n' "${READ_TOOLS[@]}"
    exit 0 ;;
  --usage)
    exec "$HERE/report-usage.sh" ;;
  --install)
    chmod +x "$HERE/report-usage.sh" "$HERE/usage-statusline.sh"
    # Retire the jobs earlier versions installed.
    for old in uk.co.gitwork.foundry-drafter uk.co.gitwork.foundry-drafter-suggest uk.co.gitwork.foundry-drafter-place; do
      P="$HOME/Library/LaunchAgents/$old.plist"
      [[ -f "$P" ]] && { launchctl unload "$P" 2>/dev/null || true; rm -f "$P"; }
    done
    for job in asks usage; do
      PLIST="$HOME/Library/LaunchAgents/uk.co.gitwork.foundry-$job.plist"
      sed "s#__SCRIPT__#$HERE/draft-replies.sh#; s#__USAGE__#$HERE/report-usage.sh#; s#__LOG__#$LOG#" "$HERE/uk.co.gitwork.foundry-$job.plist" > "$PLIST"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"
    done
    # Claude Code status line: shows your limits in Claude Code and saves them for the wallpaper.
    SETTINGS="$HOME/.claude/settings.json"; mkdir -p "$HOME/.claude"; [[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
    CURRENT="$(jq -r '.statusLine.command // empty' "$SETTINGS")"
    if [[ -z "$CURRENT" || "$CURRENT" == *usage-statusline.sh* ]]; then
      cp "$SETTINGS" "$SETTINGS.bak"
      jq --arg c "$HERE/usage-statusline.sh" '.statusLine = {type: "command", command: $c}' "$SETTINGS.bak" > "$SETTINGS"
      SL="Claude Code status line set (backup: $SETTINGS.bak)."
    else
      SL="You already have a Claude Code status line ($CURRENT), so it was left alone. Claude usage won't reach the wallpaper until you switch it to $HERE/usage-statusline.sh."
    fi
    echo "Installed. Asks: hourly on weekdays, 07:00–19:00. Usage: every 5 minutes. $SL Log: $LOG"
    exit 0 ;;
  --scheduled)
    dow=$(date +%u); hr=$(date +%H)
    if (( dow > 5 || 10#$hr < 7 || 10#$hr >= 19 )); then exit 0; fi ;;
esac

(( ${#TARGETS[@]} )) || { echo "Add your wallpaper link (https://…?k=…) to WALLPAPERS in $ENV_FILE"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code isn't installed (curl -fsSL https://claude.ai/install.sh | bash)"; exit 1; }
command -v jq >/dev/null || { echo "jq is needed (brew install jq)"; exit 1; }
MAIN="${TARGETS[0]}"

# ---------------- asks ----------------
KNOWN="$(curl -fsS "$(base_of "$MAIN")/api/data?k=$(key_of "$MAIN")" | jq -r '.asks.items[]? | "\(.ref)  \(.what)  (\(.state))"' 2>/dev/null || true)"
PROMPT="$(cat "$HERE/asks.md")

## Already known (skip unless the deadline changed)
${KNOWN:-none}

Today is $(date '+%A %d %B %Y, %H:%M %Z')."

log "asks: run started"
REPORT="$(claude -p "$PROMPT" --output-format json --model "${MODEL:-sonnet}" --json-schema "$(cat "$HERE/asks-schema.json")" \
  --allowedTools "${READ_TOOLS[@]}" --disallowedTools "${DENIED[@]}" 2>>"$LOG" \
  | jq -c '.structured_output // (.result | fromjson? ) // empty')" || true
[[ -n "$REPORT" ]] || { log "asks: no report from Claude"; exit 1; }

for link in "${TARGETS[@]}"; do
  curl -fsS -X PUT -H 'content-type: application/json' --data "$REPORT" "$(base_of "$link")/api/asks?k=$(key_of "$link")" >> "$LOG" \
    || log "asks: couldn't reach $(base_of "$link")"
done
log "asks: $(jq '.asks | length' <<<"$REPORT") found"
jq '.' <<<"$REPORT"
