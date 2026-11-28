---
description: 在討論裡替 Owner 發言(@成員 指定下一個、/stop 中止這一輪、/end 收尾)
argument-hint: [主題] <要說的話>
allowed-tools: Bash(node:*)
---

# /k-chat:say

先讀 `k-chat` skill。參數:`$ARGUMENTS`

1. 找到是哪一場:`node ${CLAUDE_PLUGIN_ROOT}/runner.mjs list --repo "<主 repo>"`。只有一場進行中就是它;有好幾場而參數沒講 → 問。
2. 照使用者的原話送出(不改寫、不加料):
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runner.mjs say "<state.json>" "<原話>"
   ```
3. 讀 `<state.json>` 的 `runner`:是 `null` 或 `at` 超過 30 秒 → 沒人在主持,`node ${CLAUDE_PLUGIN_ROOT}/runner.mjs start "<state.json>"`。

回報一行:送到哪一場、主持程式在不在跑。不用等回答;使用者要看結果再讀 `<主題>.md` 最後幾則。
