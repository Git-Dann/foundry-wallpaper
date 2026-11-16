#!/usr/bin/env bash
# Sends your Claude and Codex plan usage to the wallpaper. Run every 5 minutes by launchd.
#   Claude: saved by usage-statusline.sh whenever Claude Code redraws its status line.
#   Codex:  read from the newest Codex session log (~/.codex/sessions), which records the limits.
# Nothing here calls Claude or Codex, so it costs nothing.
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
STATE="$HOME/.foundry-drafter"
# shellcheck disable=SC1091
source "$STATE/env" 2>/dev/null || { echo "No $STATE/env yet"; exit 1; }

claude_json='null'
if [[ -f "$STATE/claude-usage.json" ]]; then
  claude_json="$(jq -c '{at, fiveHour: (.limits.five_hour // null | if . then {pct: .used_percentage, resetsAt: .resets_at} else null end), week: (.limits.seven_day // null | if . then {pct: .used_percentage, resetsAt: .resets_at} else null end)}' "$STATE/claude-usage.json" 2>/dev/null || echo null)"
fi

codex_json='null'
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}/sessions"
if [[ -d "$CODEX_DIR" ]]; then
  newest="$(find "$CODEX_DIR" -name '*.jsonl' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1)"
  if [[ -n "$newest" ]]; then
    # GNU stat first: BSD (macOS) stat has no -c, and GNU stat -f means something else.
    at="$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest")"
    # The last line that carries rate_limits, wherever Codex nests it.
    rl="$(tail -n 400 "$newest" | jq -c '[.. | objects | select(has("rate_limits")) | .rate_limits | select(. != null)] | last // empty' 2>/dev/null | tail -n 1)"
    if [[ -n "$rl" ]]; then
      codex_json="$(jq -c --argjson at "$at" '
        def win($w): if $w == null then null else
          { pct: ($w.used_percent // $w.used_percentage),
            minutes: ($w.window_minutes // null),
            resetsAt: (if $w.resets_at then $w.resets_at elif $w.resets_in_seconds then ($at + $w.resets_in_seconds) else null end) } end;
        {at: $at, fiveHour: win(.primary), week: win(.secondary)}' <<<"$rl")"
    else
      codex_json="$(jq -cn --argjson at "$at" '{at: $at, fiveHour: null, week: null, note: "Codex logs have no limit data yet"}')"
    fi
  fi
fi

BODY="$(jq -cn --argjson c "$claude_json" --argjson x "$codex_json" '{claude: $c, codex: $x}')"
while read -r link; do
  [[ "$link" == https://*"?k="* ]] || continue
  base="${link%%\?*}"; base="${base%/}"; key="${link#*\?k=}"
  curl -fsS -m 15 -X PUT -H 'content-type: application/json' --data "$BODY" "$base/api/usage?k=$key" >/dev/null || echo "[$(date '+%F %T')] usage: couldn't reach $base" >> "$STATE/drafter.log"
done <<<"${WALLPAPERS:-}"
