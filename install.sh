#!/bin/bash
# 安裝 herdr-essentials 的 mod 到 Herdr App home,並做一份 k-main layout(= 你的 main,換成 k-tabs / k-spaces)。
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
# 只裝有 mod.json 的資料夾:已拿掉的 mod 可能在 repo 裡留下沒進版控的空殼(gpui-kit.d.ts 之類)。
for m in "$HERE"/mods/*/; do
  [ -f "$m/mod.json" ] || continue
  name=$(basename "$m"); src=${m%/}; dst=$H/mods/$name
  if [ -L "$dst" ] || [ -d "$dst" ]; then rm -rf "$dst"; fi    # 不管之前是 copy 還是 link,都重做
  if [ "$MODE" = link ]; then ln -s "$src" "$dst"; echo "mod: $name -> $src"
  else mkdir -p "$dst"; cp -r "$src/." "$dst/"; echo "mod: $name (copy)"; fi
done
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
command -v herdr-app >/dev/null && for m in "$HERE"/mods/*/; do [ -f "$m/mod.json" ] || continue; herdr-app check "$H/mods/$(basename "$m")" 2>&1 | grep -v libEGL || true; done
