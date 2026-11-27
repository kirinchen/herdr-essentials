#!/bin/bash
# 輔助程式的冒煙測試:開視窗 → 頁面傳訊息 → 改 data / 大小 → 刪 spec 關視窗 → 閒置自己結束。
# 用法:tools/k-float/tests/smoke.sh [截圖.png]     (先 cargo build --release;畫在測試環境的 Xvfb :99;要畫在實體桌面:K_FLOAT_DISPLAY=:0)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=$HERE/target/release/k-float
export DISPLAY=${K_FLOAT_DISPLAY:-:99}   # 不沿用環境的 DISPLAY:那是實體桌面 :0
SHOT=${1:-}
D=$(mktemp -d)
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
has() { grep -q "$2" "$D/events/demo.jsonl" 2>/dev/null && ok "$1" || bad "$1"; }
run() { env -u TMUX -u CLAUDECODE K_FLOAT_IDLE_SECS=3 "$BIN" "$@"; }

mkdir -p "$D/windows"
cat > "$D/windows/demo.json" <<'EOF'
{"title":"k-float-smoke","x":60,"y":60,"width":300,"height":200,
 "html":"<body style='font:16px sans-serif;background:#fffbe6'><h3 id=h>hello</h3><button onclick=\"float.send({click:1})\">+</button><script>float.onData(d=>{h.textContent='count '+d.count;float.send({got:d.count})})</script></body>",
 "data":{"count":1}}
EOF

[ "$(run start "$D")" = started ] && ok "start" || bad "start"
sleep 3
[ "$(run start "$D")" = running ] && ok "second start is a no-op" || bad "second start is a no-op"
has "ready event" '"type":"ready"'
has "page got the first data and answered" '"data":{"got":1}'
xwininfo -root -tree | grep -q k-float-smoke && ok "window exists" || bad "window exists"

python3 - "$D/windows/demo.json" <<'EOF'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["data"] = {"count": 7}; s["width"] = 360
json.dump(s, open(p, "w"))
EOF
sleep 1.5
has "data update reached the page without a reload" '"data":{"got":7}'
[ "$(grep -c '"type":"ready"' "$D/events/demo.jsonl")" = 1 ] && ok "no reload on data update" || bad "no reload on data update"
xwininfo -root -tree | grep k-float-smoke | grep -q 360x && ok "resized to 360" || bad "resized to 360"
[ -n "$SHOT" ] && ffmpeg -loglevel error -y -f x11grab -video_size 800x500 -i "$DISPLAY" -frames:v 1 "$SHOT"

# 半透明:設到視窗屬性上;桌面沒有合成器(測試環境的 Xvfb)時畫面不會變,要記一筆 warning,有合成器就不該記。
python3 - "$D/windows/demo.json" <<'EOF'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["opacity"] = 0.6
json.dump(s, open(p, "w"))
EOF
sleep 1.5
W=$(xwininfo -root -tree | grep '"k-float-smoke"' | head -1 | awk '{print $1}')
xprop -id "$W" _NET_WM_WINDOW_OPACITY 2>/dev/null | grep -q '= [0-9]' && ok "opacity set on the window" || bad "opacity set on the window"
warned=no; grep '"type":"warning"' "$D/events/demo.jsonl" 2>/dev/null | grep -q opacity && warned=yes
# 有沒有合成器:看 _NET_WM_CM_S0 這個 selection 有沒有人持有(要 python3-xlib;沒有就只印出來不判)。
blend=$(python3 -c 'from Xlib import display
d = display.Display(); print("yes" if d.get_selection_owner(d.intern_atom("_NET_WM_CM_S%d" % d.get_default_screen())) else "no")' 2>/dev/null)
case "$blend/$warned" in
  yes/no) ok "opacity: the desktop blends windows, no warning";;
  no/yes) ok "opacity: the desktop doesn't blend windows, warned";;
  /*) echo "     opacity warning: $warned (python3-xlib missing: can't tell whether this desktop blends windows)";;
  *) bad "opacity warning (desktop blends windows: $blend, warned: $warned)";;
esac
[ "$(grep -c '"type":"ready"' "$D/events/demo.jsonl")" = 1 ] && ok "no reload on opacity update" || bad "no reload on opacity update"

echo '{not json' > "$D/windows/broken.json"; sleep 1
grep -q '"type":"error"' "$D/events/broken.jsonl" 2>/dev/null && ok "bad spec reports an error" || bad "bad spec reports an error"
rm "$D/windows/broken.json"

rm "$D/windows/demo.json"; sleep 1
has "closed by spec" '"by":"spec"'
xwininfo -root -tree | grep -q k-float-smoke && bad "window gone" || ok "window gone"
sleep 5
pgrep -f "k-float run $D" >/dev/null && { bad "idle exit"; run stop "$D"; } || ok "idle exit"

[ $fail = 0 ] || { echo "--- events"; cat "$D"/events/*.jsonl; echo "--- log"; cat "$D/helper.log"; }
rm -rf "$D"
exit $fail
