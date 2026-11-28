---
description: 看這個 repo 的討論:哪幾場、第幾輪、誰在發言、最後說了什麼
argument-hint: [主題]
allowed-tools: Bash(node:*), Read
---

# /k-chat:status

先讀 `k-chat` skill。參數:`$ARGUMENTS`

1. `node ${CLAUDE_PLUGIN_ROOT}/runner.mjs list --repo "<主 repo>"`。
2. 沒指定主題 → 每場一行:主題、狀態(進行中 / 等 Owner / 已結束)、輪數、成員。
3. 指定了(或只有一場)→ 讀 `<主題>.json`(`status`、`round`、`now`、`todos`、`runner`)和 `<主題>.md` 的最後 3 則,摘要:
   - 現在輪到誰、等多久了;主持程式在不在跑(不在就說,問要不要 `start`)。
   - 最後幾則各一兩句;有 `🔓` 的那則要點出來(誰被授權動手、理由)。
   - 已結束 → 結論的決定與待辦(哪些已開卡)。

只讀,不發言、不啟動任何東西。
