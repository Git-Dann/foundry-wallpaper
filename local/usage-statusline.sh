#!/usr/bin/env bash
# Claude Code status line: shows your plan limits in the status bar, and saves them for the
# wallpaper. Claude Code passes `rate_limits` (5-hour and weekly windows) to this script on stdin
# whenever it redraws the status line. Installed by ./draft-replies.sh --install.
input="$(cat)"
OUT="$HOME/.foundry-drafter/claude-usage.json"
mkdir -p "$(dirname "$OUT")"
if command -v jq >/dev/null; then
  limits="$(jq -c '.rate_limits // empty' <<<"$input" 2>/dev/null)"
  if [[ -n "$limits" && "$limits" != "null" ]]; then
    jq -c --argjson at "$(date +%s)" '{at: $at, limits: .}' <<<"$limits" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  fi
  five="$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$input" 2>/dev/null)"
  week="$(jq -r '.rate_limits.seven_day.used_percentage // empty' <<<"$input" 2>/dev/null)"
  model="$(jq -r '.model.display_name // empty' <<<"$input" 2>/dev/null)"
  line="$model"
  [[ -n "$five" ]] && line="$line · 5h $(printf '%.0f' "$five")%"
  [[ -n "$week" ]] && line="$line · week $(printf '%.0f' "$week")%"
  printf '%s' "${line# · }"
fi
