#!/usr/bin/env bash
# Foundry drafter: runs your own Claude Code on this Mac.
#
# Two jobs, and neither can send anything:
#   suggest  (hourly)    reads mail and Slack waiting on you and SUGGESTS replies on the wallpaper.
#                        It has no tool that writes to Gmail or Slack at all.
#   place    (5 minutes) saves the replies you ACCEPTED on the wallpaper as drafts. Only draft
#                        tools are allowed; send/reply/post are blocked. Costs nothing when there's
#                        nothing accepted, because it checks the wallpaper before starting Claude.
#
#   ./draft-replies.sh            suggest now
#   ./draft-replies.sh --place    save accepted replies as drafts now
#   ./draft-replies.sh --check    list your MCP servers and the tool names this script will use
#   ./draft-replies.sh --install  schedule both jobs (launchd)
#
# Config lives in ~/.foundry-drafter/env (created on first run):
#   WALLPAPERS                          your wallpaper link, "<url>?k=<key>" (one per line)
#   GMAIL_MCP, SLACK_MCP, FOUNDRY_MCP, CALENDAR_MCP   the MCP server names `claude mcp list` shows
#   MODEL                               model for both jobs (default sonnet)
set -euo pipefail
# launchd starts us with a bare PATH and bash never reads ~/.zprofile, so add where Claude Code
# (native installer) and Homebrew live, or scheduled runs can't find claude or jq.
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.foundry-drafter"
ENV_FILE="$STATE_DIR/env"
DONE_FILE="$STATE_DIR/drafted.txt"
LOG="$STATE_DIR/drafter.log"
mkdir -p "$STATE_DIR"
touch "$DONE_FILE"

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
# Model for both jobs. Sonnet is plenty for replies and far cheaper than the default.
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

# Reading only. The suggest job gets nothing that can write anywhere.
READ_TOOLS=(
  $(tools_for "$GMAIL_MCP" search_threads get_thread get_message list_drafts get_draft)
  $(tools_for "$SLACK_MCP" slack_search_public_and_private slack_read_thread slack_read_channel slack_read_user_profile slack_search_users)
  $(tools_for "$FOUNDRY_MCP" whoami list_clients get_client list_tasks get_task find_meetings list_wiki get_wiki_page list_documents list_conversations)
  $(tools_for "$CALENDAR_MCP" list_events search_events get_event)
)
# The place job: read the thread it's answering, then save a draft. Nothing else.
PLACE_TOOLS=(
  $(tools_for "$GMAIL_MCP" get_thread get_message list_drafts create_draft)
  $(tools_for "$SLACK_MCP" slack_read_thread slack_send_message_draft)
)
# Belt and braces: name the dangerous ones explicitly too.
DENIED=(
  Bash Write Edit NotebookEdit WebFetch
  $(tools_for "$GMAIL_MCP" send_message reply forward trash_message trash_thread delete_draft update_draft)
  $(tools_for "$SLACK_MCP" slack_send_message slack_schedule_message slack_create_canvas slack_update_canvas)
)
SUGGEST_DENIED=("${DENIED[@]}" $(tools_for "$GMAIL_MCP" create_draft) $(tools_for "$SLACK_MCP" slack_send_message_draft))

TARGETS=(); while read -r line; do [[ "$line" == https://*"?k="* ]] && TARGETS+=("$line"); done <<<"${WALLPAPERS:-}"
base_of() { local b="${1%%\?*}"; echo "${b%/}"; }
key_of() { echo "${1#*\?k=}"; }
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

case "${1:-}" in
  --check)
    claude mcp list
    echo
    echo "Tools this script uses (each must exist in the list above):"
    printf '  %s\n' "${READ_TOOLS[@]}" $(tools_for "$GMAIL_MCP" create_draft) $(tools_for "$SLACK_MCP" slack_send_message_draft)
    exit 0 ;;
  --install)
    for job in suggest place; do
      PLIST="$HOME/Library/LaunchAgents/uk.co.gitwork.foundry-drafter-$job.plist"
      sed "s#__SCRIPT__#$HERE/draft-replies.sh#; s#__LOG__#$LOG#" "$HERE/uk.co.gitwork.foundry-drafter-$job.plist" > "$PLIST"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"
    done
    # The single job from before this change, if it's still there.
    OLD="$HOME/Library/LaunchAgents/uk.co.gitwork.foundry-drafter.plist"
    [[ -f "$OLD" ]] && { launchctl unload "$OLD" 2>/dev/null || true; rm -f "$OLD"; }
    echo "Installed. Suggestions: hourly on weekdays, 07:00–19:00. Accepted replies saved as drafts: every 5 minutes. Log: $LOG"
    exit 0 ;;
esac

(( ${#TARGETS[@]} )) || { echo "Add your wallpaper link (https://…?k=…) to WALLPAPERS in $ENV_FILE"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code isn't installed (curl -fsSL https://claude.ai/install.sh | bash)"; exit 1; }
command -v jq >/dev/null || { echo "jq is needed (brew install jq)"; exit 1; }
MAIN="${TARGETS[0]}"

run_claude() { # prompt schema allowed... -- denied...
  local prompt="$1" schema="$2"; shift 2
  local allowed=() denied=() into=allowed
  for a in "$@"; do if [[ "$a" == "--" ]]; then into=denied; continue; fi; if [[ $into == allowed ]]; then allowed+=("$a"); else denied+=("$a"); fi; done
  claude -p "$prompt" --output-format json --model "${MODEL:-sonnet}" --json-schema "$(cat "$schema")" \
    --allowedTools "${allowed[@]}" --disallowedTools "${denied[@]}" 2>>"$LOG" \
    | jq -c '.structured_output // (.result | fromjson? ) // empty'
}

# ---------------- place: save what Dan accepted, as drafts ----------------
if [[ "${1:-}" == "--place" || "${1:-}" == "--place-scheduled" ]]; then
  QUEUE="$(curl -fsS "$(base_of "$MAIN")/api/drafts/queue?k=$(key_of "$MAIN")")" || { log "place: couldn't reach the wallpaper"; exit 1; }
  N="$(jq '.items | length' <<<"$QUEUE")"
  if [[ "$N" == "0" ]]; then [[ "${1:-}" == "--place" ]] && echo "Nothing accepted to save."; exit 0; fi
  log "place: $N accepted"
  PROMPT="$(cat "$HERE/place.md")

## Accepted replies to save as drafts
$(jq '.items | map({id, source, ref, to, subject, body})' <<<"$QUEUE")"
  REPORT="$(run_claude "$PROMPT" "$HERE/place-schema.json" "${PLACE_TOOLS[@]}" -- "${DENIED[@]}")" || true
  [[ -n "$REPORT" ]] || { log "place: no report from Claude"; exit 1; }
  curl -fsS -X POST -H 'content-type: application/json' --data "$REPORT" "$(base_of "$MAIN")/api/drafts/placed?k=$(key_of "$MAIN")" >> "$LOG" || log "place: couldn't report back"
  log "place: $(jq '[.results[] | select(.ok)] | length' <<<"$REPORT") saved"
  jq '.' <<<"$REPORT"
  exit 0
fi

# ---------------- suggest ----------------
if [[ "${1:-}" == "--scheduled" ]]; then
  dow=$(date +%u); hr=$(date +%H)
  if (( dow > 5 || 10#$hr < 7 || 10#$hr >= 19 )); then exit 0; fi
fi

SEEN="$(curl -fsS "$(base_of "$MAIN")/api/drafts/refs?k=$(key_of "$MAIN")" | jq -r '.refs[]?' 2>/dev/null || true)"
PROMPT="$(cat "$HERE/prompt.md")

## Already handled (skip these refs)
$(printf '%s\n%s\n' "$SEEN" "$(tail -n 200 "$DONE_FILE")" | sort -u)

Today is $(date '+%A %d %B %Y, %H:%M %Z')."

log "suggest: run started"
REPORT="$(run_claude "$PROMPT" "$HERE/draft-schema.json" "${READ_TOOLS[@]}" -- "${SUGGEST_DENIED[@]}")" || true
[[ -n "$REPORT" ]] || { log "suggest: no report from Claude"; exit 1; }

jq -r '.suggestions[]?.ref // empty' <<<"$REPORT" >> "$DONE_FILE"
for link in "${TARGETS[@]}"; do
  # One wallpaper being down mustn't lose the report for the others.
  curl -fsS -X PUT -H 'content-type: application/json' --data "$REPORT" "$(base_of "$link")/api/drafts?k=$(key_of "$link")" >> "$LOG" \
    || log "suggest: couldn't reach $(base_of "$link")"
done
log "suggest: $(jq '.suggestions | length' <<<"$REPORT") suggested"
jq '.' <<<"$REPORT"
