#!/bin/sh
# Claude Code statusLine 回報器(herdr-essentials):把這個 session 的模型與強度寫成
# 它所在 herdr-core terminal 的標籤 herdr.model / herdr.effort / herdr.model_app,
# k-agents 讀 terminals() 的 labels,在 Agents 列用不同 icon / 底色顯示。
# 不印任何東西(不顯示狀態列)。不需要 jq;只在值變了才呼叫 hc。
# 參考 OliverRC/herdr-model-effort 的 reporters/claude-code.sh。
[ -n "$HC_TERMINAL_ID" ] || exit 0
input=$(cat)
model=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"model" *: *{[^}]*"display_name" *: *"\([^"]*\)".*/\1/p')
effort=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"effort" *: *{[^}]*"level" *: *"\([^"]*\)".*/\1/p')
now="$model|$effort"
cache="${TMPDIR:-/tmp}/herdr-statusline-$(printf '%s' "$HC_TERMINAL_ID" | tr -c 'A-Za-z0-9_-' '_')"
[ "$(cat "$cache" 2>/dev/null)" = "$now" ] && exit 0
hc label "$HC_TERMINAL_ID" "herdr.model=$model" "herdr.effort=$effort" herdr.model_app=claude-code >/dev/null 2>&1 \
  && printf '%s' "$now" > "$cache"
exit 0
