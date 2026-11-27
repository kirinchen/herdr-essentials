#!/bin/bash
# 開一個示範視窗、截圖、印視窗資訊,然後收掉。看畫面用(冒煙測試只看事件)。
# 用法:tools/k-float/tests/peek.sh <截圖.png> [秒數]
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=$HERE/target/release/k-float
export DISPLAY=${K_FLOAT_DISPLAY:-:99}   # 不沿用環境的 DISPLAY:那是實體桌面 :0
SHOT=$1; HOLD=${2:-3}
D=$(mktemp -d); mkdir -p "$D/windows"
cat > "$D/windows/demo.json" <<'EOF'
{"title":"k-float-peek","x":80,"y":80,"width":300,"height":200,
 "html":"<body style='font:16px sans-serif;background:#fffbe6;margin:12px'><h3 id=h>k-float</h3><p>always on top</p><button onclick=\"float.send({click:1})\">send</button><script>float.onData(d=>{h.textContent='count '+d.count})</script></body>",
 "data":{"count":1}}
EOF
env -u TMUX -u CLAUDECODE "$BIN" start "$D"
sleep "$HOLD"
xwininfo -root -tree | grep -i -B1 -A3 k-float-peek
ID=$(xwininfo -root -tree | grep '"k-float-peek"' | head -1 | awk '{print $1}')
[ -n "$ID" ] && { xwininfo -id "$ID" | grep -E "Map State|Width|Height|Absolute"; xprop -id "$ID" _NET_WM_STATE WM_CLASS; }
RES=$(xwininfo -root | awk '/Width/{w=$2}/Height/{h=$2}END{print w"x"h}')
ffmpeg -loglevel error -y -f x11grab -video_size "$RES" -i "$DISPLAY" -frames:v 1 "$SHOT"
cat "$D"/events/*.jsonl; cat "$D/helper.log"
env -u TMUX -u CLAUDECODE "$BIN" stop "$D"; sleep 0.6; rm -rf "$D"
