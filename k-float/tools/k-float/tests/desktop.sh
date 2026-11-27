#!/bin/bash
# 在有視窗管理員的實體桌面上驗:置頂、被使用者移動會記住位置、被使用者關掉會通知並刪 spec。
# 會在螢幕上開一個小視窗約 10 秒。用法:K_FLOAT_DISPLAY=:0 k-float/tools/k-float/tests/desktop.sh [截圖.png]
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=$HERE/target/release/k-float
[ -n "${K_FLOAT_DISPLAY:-}" ] || { echo "要明確指定桌面:K_FLOAT_DISPLAY=:0" >&2; exit 2; }
export DISPLAY=$K_FLOAT_DISPLAY
SHOT=${1:-}
D=$(mktemp -d); mkdir -p "$D/windows"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
run() { env -u TMUX -u CLAUDECODE K_FLOAT_IDLE_SECS=3 "$BIN" "$@"; }
wid() { xwininfo -root -tree | grep '"k-float-desktop"' | head -1 | awk '{print $1}'; }

cat > "$D/windows/demo.json" <<'EOF'
{"title":"k-float-desktop","x":120,"y":120,"width":300,"height":160,
 "html":"<body style='font:16px sans-serif;background:#fff7c2;margin:14px'><b>k-float</b><p>always on top (test, closes itself)</p></body>"}
EOF
run start "$D" >/dev/null; sleep 3
W=$(wid); [ -n "$W" ] && ok "window exists ($W)" || bad "window exists"
xprop -id "$W" _NET_WM_STATE | grep -q _NET_WM_STATE_ABOVE && ok "window manager has it above other windows" || bad "window manager has it above other windows"
# Stacking order, bottom to top: nothing but other above/dock windows may come after ours.
top=$(xprop -root _NET_CLIENT_LIST_STACKING | tr ',' '\n' | tail -1 | grep -o '0x[0-9a-f]*')
echo "     top of the stack: $top ($(xprop -id "$top" WM_CLASS 2>/dev/null | cut -d'"' -f2))"
[ -n "$SHOT" ] && { xwd -root -silent | ffmpeg -loglevel error -y -i - "$SHOT" 2>/dev/null || echo "     (no screenshot)"; }

wmctrl -i -r "$W" -e 0,400,300,-1,-1; sleep 1.5
grep -q '"type":"moved"' "$D/events/demo.jsonl" && ok "moved event: $(grep '"moved"' "$D/events/demo.jsonl" | tail -1)" || bad "moved event"
grep -q '"x":120' "$D/windows/demo.json" && bad "spec remembers the new place" || ok "spec remembers the new place: $(grep -o '"x":[0-9.]*,"y":[0-9.]*' "$D/windows/demo.json")"

wmctrl -i -c "$W"; sleep 1.5
grep -q '"by":"user"' "$D/events/demo.jsonl" && ok "closed by user event" || bad "closed by user event"
[ -e "$D/windows/demo.json" ] && bad "spec removed" || ok "spec removed"
[ -z "$(wid)" ] && ok "window gone" || bad "window gone"

[ $fail = 0 ] || { echo "--- events"; cat "$D"/events/*.jsonl; echo "--- log"; cat "$D/helper.log"; }
run stop "$D"; sleep 0.5; rm -rf "$D"
exit $fail
