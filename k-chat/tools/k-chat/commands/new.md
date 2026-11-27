---
description: 開一場多 agent 討論(主席制):建檔、邀成員、啟動主持程式
argument-hint: <主題> —— <開場要討論什麼> [成員:repo 名或資料夾…]
allowed-tools: Bash(node:*), Bash(hc:*)
---

# /k-chat:new

先讀 `k-chat` skill。參數:`$ARGUMENTS`

1. **定三件事**(參數裡沒有的才問,一次問一個):
   - 主題(短,會變成檔名)與開場(要大家討論什麼)。
   - 主 repo:預設是你現在的 repo(紀錄存在它的 `doc/chat/`)。
   - 成員:每位要有資料夾的絕對路徑。使用者只給 repo 名 → `hc ls --json` 找 `cwd` 對得上的;位址有 `<機器>/` 前綴的要帶 `machine`。找不到就問,不要猜路徑。使用者說了要用哪家模型(Codex、Gemini…)→ 那位加 `"agent"`(有指定模型再加 `"model"`);主席的用 `--chair-agent` / `--chair-model`。
   - **只跟一個 agent 對話**(使用者說「一般對話」「一對一」「直接問 X」)→ 成員只放那一位,`new` 加 `--direct`(不經主席,沒有輪數上限)。預設它只能讀;使用者明說要它動手才加 `--act`,並在回報裡明講「它可以不問權限改檔、跑指令」。
2. **YOLO**:使用者沒提 → 照預設(允許主席授權),但在回報裡明講;他說「只討論、不要動手」→ 加 `--no-yolo`。
3. 建檔:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runner.mjs new --repo "<主 repo>" --topic "<主題>" --members '<JSON 陣列>' --say "<開場>" [--max-rounds N] [--no-yolo]
   ```
   印出來的是 `<主題>.json` 的路徑。「已經有這個主題」→ 問要接著那場(`/k-chat:say`)還是換個主題。
4. 啟動主持程式:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runner.mjs start "<state.json>"
   ```
   - `in_app_layout: false` 或有 `warning` → 照實轉述(討論照跑,只是 Herdr App 側欄沒有那個對話 tab)。
   - `hc run 失敗`(這台沒有 herdr-core)→ 告訴使用者,問要不要改用 `runner.mjs run`(會佔住一個 terminal,要他自己開)。不要自己在背景硬跑。

## 回報

```
開了:<主題> —— <成員…>,上限 <N> 輪,YOLO <主席可授權 | 關>
紀錄:<主 repo>/doc/chat/<主題>.md
主持:<terminal 名>(<位址>)
```
