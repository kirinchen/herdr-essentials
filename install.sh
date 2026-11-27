#!/bin/bash
# 安裝 herdr-essentials 的 mod 到 Herdr App home,並做一份 k-main layout(= 你的 main,換成 k-tabs / k-spaces / k-pane …)。
# 用法:./install.sh            預設 symlink:App home 的 mods/k-* 指到這個 repo,改 repo 即生效,直接 git commit
#      ./install.sh --copy     複製一份(Windows 沒開 symlink 權限時用);之後改動要重跑才會更新
#      (預設 home ~/.config/herdr-app;HERDR_APP_HOME 可改)
# 之後:herdr-app do layout.switch --name k-main     回原樣:layout.switch --name main
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
H=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
[ -d "$H/layouts" ] || { echo "找不到 $H/layouts:先開過一次 Herdr App" >&2; exit 1; }
MODE=link; [ "${1:-}" = "--copy" ] && MODE=copy
# Windows(Git Bash)沒有 symlink 權限時,ln -s 會默默改成複製,之後 git pull 不會生效。
# 改成要嘛建真的 symlink、要嘛失敗,再先試一次:不行就自動改用複製模式。
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) export MSYS="${MSYS:+$MSYS }winsymlinks:nativestrict" CYGWIN="${CYGWIN:+$CYGWIN }winsymlinks:nativestrict";; esac
if [ "$MODE" = link ]; then
  t=$(mktemp -d); if ! { ln -s "$HERE/mods" "$t/probe" 2>/dev/null && [ -L "$t/probe" ]; }; then
    MODE=copy; echo "這台不能建 symlink(Windows 要開「開發人員模式」),改用複製模式:之後 repo 有改動要重跑 ./install.sh" >&2
  fi; rm -rf "$t"
fi
for m in "$HERE"/mods/*/; do
  name=$(basename "$m"); src=${m%/}; dst=$H/mods/$name
  if [ -L "$dst" ] || [ -d "$dst" ]; then rm -rf "$dst"; fi    # 不管之前是 copy 還是 link,都重做
  if [ "$MODE" = link ]; then ln -s "$src" "$dst"; echo "mod: $name -> $src"
  else mkdir -p "$dst"; cp -r "$src/." "$dst/"; echo "mod: $name (copy)"; fi
done
# k-chat 的主持程式(tools/k-chat/runner.mjs):mod 從 App home 的 tools/k-chat 找它。跟 mod 一樣 link 或複製。
mkdir -p "$H/tools"; dst=$H/tools/k-chat
if [ -L "$dst" ] || [ -d "$dst" ]; then rm -rf "$dst"; fi
if [ "$MODE" = link ]; then ln -s "$HERE/tools/k-chat" "$dst"; echo "tool: k-chat -> $HERE/tools/k-chat"
else mkdir -p "$dst"; cp -r "$HERE/tools/k-chat/." "$dst/"; echo "tool: k-chat (copy)"; fi
command -v node >/dev/null || echo "tool: 找不到 node(k-chat 的主持程式要 Node 18+)" >&2
# k-float 的輔助程式(tools/k-float,Rust):這台自己建一支,float.js 從 App home 的 tools/k-float/target/release 找它。
# link 模式整個資料夾 link 過去;複製模式只放執行檔(target/ 很大)。沒有 cargo 就跳過,k-float / k-note 會說找不到輔助程式。
EXE=k-float; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=k-float.exe;; esac
dst=$H/tools/k-float
# 正在跑的那支先收掉(Windows 換不掉執行中的檔)。paused:建置期間 mod 呼叫的 start 不會再把它叫起來;建完拿掉、再叫起來。
FD=$H/data/k-float
if [ -x "$dst/target/release/$EXE" ]; then mkdir -p "$FD" && touch "$FD/paused"; "$dst/target/release/$EXE" stop "$FD" 2>/dev/null && sleep 1; fi
trap 'rm -f "$FD/paused"' EXIT
if command -v cargo >/dev/null; then
  if (cd "$HERE/tools/k-float" && cargo build --release --quiet); then
    if [ -L "$dst" ] || [ -d "$dst" ]; then rm -rf "$dst"; fi
    if [ "$MODE" = link ]; then ln -s "$HERE/tools/k-float" "$dst"; echo "tool: k-float -> $HERE/tools/k-float"
    else mkdir -p "$dst/target/release"; cp "$HERE/tools/k-float/target/release/$EXE" "$dst/target/release/"; echo "tool: k-float (copy)"; fi
  else echo "tool: k-float 建置失敗(Linux 要 libwebkit2gtk-4.1-dev、libgtk-3-dev),k-float / k-note 先不能用" >&2; fi
else echo "tool: 找不到 cargo,k-float 的輔助程式沒建(k-float / k-note 先不能用);裝 Rust 後重跑" >&2; fi
rm -f "$FD/paused"
# 收掉前開著的視窗(windows/*.json 還在):叫回來。沒有就不叫,它也會自己結束。
if [ -x "$dst/target/release/$EXE" ] && ls "$FD"/windows/*.json >/dev/null 2>&1; then
  echo "tool: k-float 重新開視窗:$(env -u TMUX -u CLAUDECODE "$dst/target/release/$EXE" start "$FD" 2>&1)"
fi
# 舊版的 k-profiles、k-mods 已併進 k-settings(Settings 裡的 Profiles、Mods 頁):拿掉留在 App home 的舊 link / 複本。
for old in k-profiles k-mods; do
  if [ -L "$H/mods/$old" ] || [ -d "$H/mods/$old" ]; then rm -rf "$H/mods/$old"; echo "mod: $old 已併進 k-settings,移除舊的"; fi
done
K=$H/layouts/k-main.json
if [ -e "$K" ]; then
  echo "layout: k-main.json 已存在,不重做;只補上新版的換法"
else
  sed -E 's/"mod": *"tabs"/"mod": "k-tabs"/; s/"mod": *"spaces"/"mod": "k-spaces"/' "$H/layouts/main.json" > "$K"
  grep -q '"k-tabs"' "$K" && grep -q '"k-spaces"' "$K" \
    || { echo "layout: main.json 裡找不到 tabs / spaces block,k-main.json 可能沒換到,請手動檢查" >&2; exit 1; }
  echo "layout: k-main.json"
fi
# k-chrome(Settings 開 k-settings,裡面有 Profiles、Mods 頁):換掉 workspace-chrome,底部維持兩列的 69px;
# 舊版裝過的(97px 三列、125px 四列)縮回 69px。重跑不會重複換。
if ! grep -q '"k-chrome"' "$K"; then
  sed -i.bak -E 's/"mod": *"workspace-chrome"/"mod": "k-chrome"/g' "$K" && rm -f "$K.bak"
  grep -q '"k-chrome"' "$K" && echo "layout: k-main 換成 k-chrome(Settings 裡有 Profiles、Mods)" || echo "layout: 找不到 workspace-chrome,Settings 還是內建版(用 herdr-app do mod.open --name k-settings 開)" >&2
elif grep -qE '"px": *(97|125)([^0-9]|$)' "$K"; then
  sed -i.bak -E 's/"px": *(97|125)([^0-9]|$)/"px": 69\2/' "$K" && rm -f "$K.bak"
  echo "layout: k-main 底部縮回 69px(Profiles、Mods 移進 Settings)"
fi
# k-agents(agent 列右鍵「Copy address」):換掉內建 agents。重跑不會重複換。
if ! grep -q '"k-agents"' "$K"; then
  sed -i.bak -E 's/"mod": *"agents"/"mod": "k-agents"/g' "$K" && rm -f "$K.bak"
  grep -q '"k-agents"' "$K" && echo "layout: k-main 換成 k-agents(右鍵 Copy address)" || echo "layout: 找不到 agents block,k-agents 沒換上" >&2
fi
# k-files(Markdown 檔顯示成排版後的樣子,可切回原始文字):換掉內建 files。重跑不會重複換。
if ! grep -q '"k-files"' "$K"; then
  sed -i.bak -E 's/"mod": *"files"/"mod": "k-files"/g' "$K" && rm -f "$K.bak"
  grep -q '"k-files"' "$K" && echo "layout: k-main 換成 k-files(Markdown 預覽)" || echo "layout: 找不到 files block,k-files 沒換上" >&2
fi
# k-pane(terminal 標頭,別的 mod 可以往裡面放東西):換掉內建 pane 標頭。已換成別的標頭就不動。
if ! grep -q '"k-pane"' "$K"; then
  sed -i.bak -E 's/"mod": *"pane"/"mod": "k-pane"/g' "$K" && rm -f "$K.bak"
  grep -q '"k-pane"' "$K" && echo "layout: k-main 的 pane 標頭換成 k-pane" || echo "layout: pane 標頭不是內建的 pane,沒換成 k-pane" >&2
fi
# k-status(下方狀態列,多了原本在 tab 列右邊的 Attach / Paste shot / Files / Changes):換掉內建 workspace-status。已換成別的就不動。
if ! grep -q '"k-status"' "$K"; then
  sed -i.bak -E 's/"mod": *"workspace-status"/"mod": "k-status"/g' "$K" && rm -f "$K.bak"
  grep -q '"k-status"' "$K" && echo "layout: k-main 的狀態列換成 k-status(Attach / Files / Changes 在下方)" || echo "layout: 狀態列不是內建的 workspace-status,沒換成 k-status(Attach / Files / Changes 按鈕不會出現)" >&2
fi
# k-attach(Attach / Paste shot,原本在 k-status 裡、程式在 k-tabs):狀態列切成兩塊,右邊放 k-attach。要 node 改 JSON。重跑不會重複換。
if ! grep -q '"k-attach"' "$K"; then
  if command -v node >/dev/null && K="$K" node -e '
    const fs = require("fs"), f = process.env.K, l = JSON.parse(fs.readFileSync(f, "utf8"));
    let done = false;
    (function walk(n) {
      (n.children ?? []).forEach((c, i) => {
        if (!done && c.type === "block" && c.content?.mod === "k-status") {
          n.children[i] = { id: "status-row", type: "row", size: c.size, children: [{ ...c, size: { weight: 1 } }, { id: "attach", type: "block", content: { mod: "k-attach" }, size: { px: 190 } }] };
          done = true;
        } else walk(c);
      });
    })(l);
    if (!done) process.exit(1);
    fs.writeFileSync(f, JSON.stringify(l, null, 2) + "\n");'; then echo "layout: k-main 的狀態列右邊放 k-attach(Attach / Paste shot)"
  else echo "layout: 沒找到 k-status 或沒有 node,k-attach 沒放進 k-main(Attach / Paste shot 不會出現)" >&2; fi
fi
# k-pick 的快捷鍵 ctrl-f12(對話框開著時只能用快捷鍵開,點標題列的準心會先關掉對話框)。已綁別的就不動。
KJ=$H/keys.json
if [ -e "$KJ" ]; then
  if grep -q '"ctrl-f12": *"mod.open:k-pick"' "$KJ"; then :
  elif grep -q '"ctrl-f12"' "$KJ"; then echo "keys: ctrl-f12 已綁別的,k-pick 沒加快捷鍵(自己在 keys.json 改)" >&2
  elif grep -qE '"global": *\{[[:space:]]*$' "$KJ"; then
    sed -i.bak -E 's/("global": *\{)/\1\n    "ctrl-f12": "mod.open:k-pick",/' "$KJ" && rm -f "$KJ.bak"; echo "keys: ctrl-f12 開 k-pick"
  else echo "keys: keys.json 的 global 格式認不得,自己加 \"ctrl-f12\": \"mod.open:k-pick\"" >&2; fi
else
  echo "keys: 還沒有 keys.json(用內建預設),k-pick 沒加快捷鍵:先在 Settings 改一個快捷鍵讓它產生再重跑" >&2
fi
# k-chrome 的來回導覽(照 Eclipse):alt-left / alt-right 回到上一個 / 下一個看過的 session,ctrl-q 回到最後輸入的 session。
# 沒綁的加上;alt-left / alt-right 還是內建預設的 pane.go(alt-h / alt-l 也是它)就換掉;綁了別的不動。
navkey() { # <鍵> <指令> [可以換掉的預設]
  if [ ! -e "$KJ" ]; then return
  elif grep -q "\"$1\": *\"$2\"" "$KJ"; then :
  elif [ -n "${3:-}" ] && grep -q "\"$1\": *\"$3\"" "$KJ"; then
    sed -i.bak -E "s/\"$1\": *\"$3\"/\"$1\": \"$2\"/" "$KJ" && rm -f "$KJ.bak"; echo "keys: $1 從 $3 改成 $2"
  elif grep -q "\"$1\"" "$KJ"; then echo "keys: $1 已綁別的,沒改成 $2(自己在 keys.json 改)" >&2
  elif grep -qE '"global": *\{[[:space:]]*$' "$KJ"; then
    sed -i.bak -E "s/(\"global\": *\{)/\\1\n    \"$1\": \"$2\",/" "$KJ" && rm -f "$KJ.bak"; echo "keys: $1 → $2"
  else echo "keys: keys.json 的 global 格式認不得,自己加 \"$1\": \"$2\"" >&2; fi
}
# Attach / Paste shot 的指令從 k-tabs 搬到 k-attach:綁過的快捷鍵跟著換名。
[ -e "$KJ" ] && grep -q '"k-tabs\.\(attach\|paste-shot\)"' "$KJ" && sed -i.bak -E 's/"k-tabs\.(attach|paste-shot)"/"k-attach.\1"/g' "$KJ" && rm -f "$KJ.bak" && echo "keys: k-tabs.attach / paste-shot 改成 k-attach.*"
navkey alt-left k-chrome.back pane.go:left
navkey alt-right k-chrome.forward pane.go:right
navkey ctrl-q k-chrome.last-input
# 快速前往(照 Eclipse 的 Ctrl+Shift+T「Open Type」):開內建的 picker —— 直接打字過濾 tab / Space / agent,↑↓ 選,Enter 過去。
# ctrl-shift-t 還是內建預設的 tab.new 就換掉(開新 tab 用 tab 列或 Space 列的「+」);綁了別的不動。ctrl-shift-k 原本就是它,留著。
navkey ctrl-shift-t mod.open:picker tab.new
# Claude Code 的 statusLine 回報器:把模型、強度寫成 terminal 標籤,k-agents 的 Agents 列換 icon / 底色。
# 只在 ~/.claude/settings.json 還沒有 statusLine 時加;已有別的就不動,只提醒。要 node 改 JSON。
SL="$HERE/tools/statusline/herdr-statusline.sh"
command -v cygpath >/dev/null && SL=$(cygpath -m "$SL")
CS="$HOME/.claude/settings.json"
if ! command -v node >/dev/null; then echo "statusline: 沒有 node,沒加 Claude Code statusLine(Agents 列不會顯示模型 / 強度)" >&2
else
  CS="$CS" SL="$SL" node -e '
    const fs = require("fs"), f = process.env.CS, cmd = `sh "${process.env.SL}"`;
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error("statusline: settings.json 讀不懂,沒動"); process.exit(0); } }
    const now = s.statusLine?.command ?? "";
    if (now.includes("herdr-statusline.sh")) { if (now !== cmd) { s.statusLine = { ...s.statusLine, command: cmd }; fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n"); console.log("statusline: 路徑更新"); } }
    else if (s.statusLine) console.error("statusline: Claude Code 已有別的 statusLine,沒換;要顯示模型 / 強度,在它裡面呼叫 " + cmd + "(把 stdin 轉給它)");
    else { fs.mkdirSync(require("path").dirname(f), { recursive: true }); s.statusLine = { type: "command", command: cmd }; fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n"); console.log("statusline: Claude Code 加上 herdr-statusline(Agents 列顯示模型 / 強度,新開的 session 生效)"); }'
fi
command -v herdr-app >/dev/null && for m in "$HERE"/mods/*/; do herdr-app check "$H/mods/$(basename "$m")" 2>&1 | grep -v libEGL; done
