---
description: 中途邀一個 agent 進討論(別的資料夾或別台機器)
argument-hint: [主題] <repo 名或資料夾> [--machine <名字>] [--agent claude|codex|gemini] [--model <名字>] [--fork <session 編號>]
allowed-tools: Bash(node:*), Bash(hc:*)
---

# /k-chat:invite

先讀 `k-chat` skill。參數:`$ARGUMENTS`

1. 找到是哪一場(`runner.mjs list --repo "<主 repo>"`;不只一場就問)。
2. 定成員的資料夾:絕對路徑;只給 repo 名 → `hc ls --json` 找 `cwd`,別台的帶 `machine`。找不到就問。
3. 使用者說「把那個 tab 的對話帶進來」而且給了 session 編號 → 加 `"fork": "<編號>"`;沒給編號就不要猜。
4. 送出:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runner.mjs invite "<state.json>" '{"name":"<名字>","space":"<名字>","cwd":"<路徑>","machine":<null 或 "名字">,"agent":"claude","model":null}'
   ```

紀錄裡出現 `➕ <成員> 加入討論` 才算進來了(主持程式下一輪開始前處理)。回報一行。
