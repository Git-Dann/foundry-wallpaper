#!/usr/bin/env bash
# Sends your Claude and Codex plan usage to the wallpaper. Run every 5 minutes by launchd.
#
# Each tool is asked for its current figures directly, so they stay fresh even when you
# haven't opened Claude Code or Codex for hours:
#   Claude: the usage Claude Code's own /usage shows, using the sign-in Claude Code keeps in your
#           Keychain. macOS asks once whether "security" may read it: choose Always Allow.
#   Codex:  the usage Codex shows, using the sign-in in ~/.codex/auth.json.
# If a direct read fails (signed out, offline, or the service changed), it falls back to the
# last figures Claude Code's status line saved, or the newest Codex session log, and says so.
# Sign-in tokens are only sent to Anthropic and OpenAI, never to the wallpaper.
#
#   ./report-usage.sh          send now
#   ./report-usage.sh --debug  print what each source returned instead of sending
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
STATE="$HOME/.foundry-drafter"
DEBUG=0; [[ "${1:-}" == "--debug" ]] && DEBUG=1
# shellcheck disable=SC1091
source "$STATE/env" 2>/dev/null || { echo "No $STATE/env yet"; exit 1; }
LOG="$STATE/drafter.log"
NOW="$(date +%s)"
dbg() { (( DEBUG )) && echo "$*" >&2; return 0; }

# ISO time or epoch (seconds or ms) → epoch seconds, inside jq.
JQ_DEFS='
  def epoch($v): if $v == null then null
    elif ($v | type) == "number" then (if $v > 1e12 then ($v / 1000 | floor) else $v end)
    else ($v | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | try fromdateiso8601 catch null) end;
  def pct($w): ($w.utilization // $w.used_percent // $w.used_percentage // $w.usedPercent);'

# ---------------- Claude ----------------
claude_json='null'; claude_src=''
tok="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)"
if [[ -n "$tok" ]]; then
  resp="$(curl -fsS -m 15 https://api.anthropic.com/api/oauth/usage \
    -H "Authorization: Bearer $tok" -H "anthropic-beta: oauth-2025-04-20" -H "content-type: application/json" 2>/dev/null)"
  dbg "claude direct: ${resp:-<no answer>}"
  [[ -n "$resp" ]] && claude_json="$(jq -c --argjson now "$NOW" "$JQ_DEFS"'
    def win($w): if $w == null or pct($w) == null then null else {pct: pct($w), resetsAt: epoch($w.resets_at // $w.resetsAt)} end;
    {at: $now, fiveHour: win(.five_hour), week: win(.seven_day)} | if .fiveHour == null and .week == null then null else . end' <<<"$resp" 2>/dev/null || echo null)"
  [[ "$claude_json" != "null" && -n "$claude_json" ]] && claude_src=direct
else
  dbg "claude direct: no Claude Code sign-in found in the Keychain"
fi
if [[ -z "$claude_src" && -f "$STATE/claude-usage.json" ]]; then
  claude_json="$(jq -c '{at, fiveHour: (.limits.five_hour // null | if . then {pct: .used_percentage, resetsAt: .resets_at} else null end), week: (.limits.seven_day // null | if . then {pct: .used_percentage, resetsAt: .resets_at} else null end)}' "$STATE/claude-usage.json" 2>/dev/null || echo null)"
  claude_src=statusline
fi
[[ -n "$claude_json" ]] || claude_json=null

# ---------------- Codex ----------------
codex_json='null'; codex_src=''
AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [[ -f "$AUTH" ]]; then
  ctok="$(jq -r '.tokens.access_token // empty' "$AUTH" 2>/dev/null)"
  cacct="$(jq -r '.tokens.account_id // empty' "$AUTH" 2>/dev/null)"
  if [[ -n "$ctok" ]]; then
    resp="$(curl -fsS -m 15 https://chatgpt.com/backend-api/wham/usage \
      -H "Authorization: Bearer $ctok" ${cacct:+-H "ChatGPT-Account-Id: $cacct"} -H "User-Agent: codex-cli" 2>/dev/null)"
    dbg "codex direct: ${resp:-<no answer>}"
    # Find the two windows wherever they sit: the shorter one is the 5-hour, the longer the week.
    [[ -n "$resp" ]] && codex_json="$(jq -c --argjson now "$NOW" "$JQ_DEFS"'
      [.. | objects | select(pct(.) != null)
        | {pct: pct(.),
           minutes: ((.limit_window_seconds // null | if . then ./60 | floor else null end) // .window_minutes),
           resetsAt: (epoch(.reset_at // .resets_at) // (if (.reset_after_seconds // .resets_in_seconds) then $now + (.reset_after_seconds // .resets_in_seconds) else null end))}]
      | sort_by(.minutes // 0) as $w
      | if ($w | length) == 0 then null else {at: $now, fiveHour: $w[0], week: (if ($w | length) > 1 then $w[-1] else null end)} end' <<<"$resp" 2>/dev/null || echo null)"
    [[ "$codex_json" != "null" && -n "$codex_json" ]] && codex_src=direct
  fi
fi
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}/sessions"
if [[ -z "$codex_src" && -d "$CODEX_DIR" ]]; then
  newest="$(find "$CODEX_DIR" -name '*.jsonl' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1)"
  if [[ -n "$newest" ]]; then
    # GNU stat first: BSD (macOS) stat has no -c, and GNU stat -f means something else.
    at="$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest")"
    rl="$(tail -n 400 "$newest" | jq -c '[.. | objects | select(has("rate_limits")) | .rate_limits | select(. != null)] | last // empty' 2>/dev/null | tail -n 1)"
    if [[ -n "$rl" ]]; then
      codex_json="$(jq -c --argjson at "$at" '
        def win($w): if $w == null then null else
          { pct: ($w.used_percent // $w.used_percentage),
            minutes: ($w.window_minutes // null),
            resetsAt: (if $w.resets_at then $w.resets_at elif $w.resets_in_seconds then ($at + $w.resets_in_seconds) else null end) } end;
        {at: $at, fiveHour: win(.primary), week: win(.secondary)}' <<<"$rl")"
      codex_src=log
    fi
  fi
fi
[[ -n "$codex_json" ]] || codex_json=null

BODY="$(jq -cn --argjson c "$claude_json" --argjson x "$codex_json" '{claude: $c, codex: $x}')"
if (( DEBUG )); then
  echo "Claude from: ${claude_src:-nowhere}   Codex from: ${codex_src:-nowhere}"
  jq . <<<"$BODY"
  exit 0
fi
# Note a fallback in the log, so "why is it old?" has an answer.
[[ "$claude_src" != direct ]] && echo "[$(date '+%F %T')] usage: Claude read from ${claude_src:-nowhere} (direct read failed)" >> "$LOG"
[[ "$codex_src" != direct ]] && echo "[$(date '+%F %T')] usage: Codex read from ${codex_src:-nowhere} (direct read failed)" >> "$LOG"
while read -r link; do
  [[ "$link" == https://*"?k="* ]] || continue
  base="${link%%\?*}"; base="${base%/}"; key="${link#*\?k=}"
  curl -fsS -m 15 -X PUT -H 'content-type: application/json' --data "$BODY" "$base/api/usage?k=$key" >/dev/null || echo "[$(date '+%F %T')] usage: couldn't reach $base" >> "$LOG"
done <<<"${WALLPAPERS:-}"
