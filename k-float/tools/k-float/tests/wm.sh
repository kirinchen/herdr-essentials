#!/bin/bash
# 要視窗管理員才驗得到的:用底下的視窗時變透明、取得焦點不透明、沒有標題列(頁面拖曳 / 改大小 / 自己的關閉縮小鈕)、
# 縮小後從 spec 叫回來、滑鼠在上面時不透明(hoverOpacity)、收合成按鈕 / 拖按鈕 / 點一下還原 / 收合後重開輔助程式。自己開一個 Xvfb + marco(開合成器),不碰實體桌面 :0 與測試環境 :99。
# 用法:tools/k-float/tests/wm.sh [截圖檔名前綴]     (先 cargo build --release;要 python3-xlib、marco)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
N=${K_FLOAT_WM_DISPLAY:-97}
[ -e "/tmp/.X11-unix/X$N" ] && { echo "display :$N is in use"; exit 2; }
# 系統沒裝 Xvfb 就用測試環境解出來的那支(dev/sandbox/setup.sh)
SB=${HERDR_SANDBOX:-$HOME/.local/share/herdr-sandbox}
XV=$(command -v Xvfb || echo "$SB/root/usr/bin/Xvfb")
LD_LIBRARY_PATH=$SB/root/usr/lib/x86_64-linux-gnu "$XV" ":$N" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & XVFB=$!
trap 'kill $WM $XVFB 2>/dev/null; wait 2>/dev/null' EXIT
for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X$N" ] && break; sleep 0.1; done
env -u TMUX -u CLAUDECODE DISPLAY=":$N" marco --sm-disable --no-keybindings --composite >/dev/null 2>&1 & WM=$!
sleep 1.5
DISPLAY=":$N" python3 "$HERE/tests/wm.py" "$HERE/target/release/k-float" "${1:-}"
