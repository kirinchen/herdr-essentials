---
name: k-chat
description: 多 agent 討論群(主席制)。使用者要「開一場討論 / 圓桌 / 找幾個 repo 的 agent 一起談」、提到 k-chat、/k-chat:*、doc/chat/ 底下的討論紀錄、或要你替他在討論裡發言 / 邀人 / 收尾時用。說明主持程式 runner.mjs 的指令、紀錄格式、權限(唯讀 / YOLO)與紅線。
---

# k-chat:多 agent 討論群

Owner(人)主持,一個主席 agent 決定每一輪誰發言。成員是各自資料夾裡的無頭 agent(Claude `claude -p`、Codex `codex exec`、Gemini `agy`),每人接續自己的 session。設計:herdr-essentials 的 `doc/ADR/0004-agent-roundtable.md`。

所有動作都走主持程式:

```bash
node ${CLAUDE_PLUGIN_ROOT}/runner.mjs <指令> …
```

## 檔案(都在主 repo 的 `doc/chat/`)

| 檔 | 內容 | 誰寫 |
|---|---|---|
| `<名字>.md` | 對話紀錄,格式同 porthole `#chat`:檔首 `# <標題>`,`## 🧑 Human · <ISO 時間>`、`## 🤖 Assistant · 成員@space · <ISO>`、`## 🤖 Assistant · 🪑 主席 · <ISO>`。`<名字>` = 主題裡的英數(沒有就 `chat-<日期>-<時間>`) | 主持程式;一對一的對話 porthole 也會寫 |
| `<主題>.json` | 狀態:成員、各自的 session、輪數、`status`(running / waiting / done)、`now`(誰在發言)、`todos`、`runner`(主持程式的 pid 與時間) | 只有主持程式 |
| `<主題>.inbox/` | 收件匣:一則訊息一個小 JSON 檔 | `say` / `invite` / `set` / `card` / `quit` |

**不要自己改 `.md` / `.json`**,也不要自己往 `.inbox/` 丟檔:用下面的指令。

## 指令

| 指令 | 做什麼 |
|---|---|
| `new --repo <主 repo> --topic <主題> --members '<JSON>' --say '<開場>' [--max-rounds 12] [--chair-agent claude] [--chair-model sonnet] [--chair-machine <機器>] [--no-yolo]` | 建檔,印出 `<主題>.json` 的路徑。還不會開始跑 |
| `start <state.json>` | 在 herdr-core 開一個自己的 terminal 來主持(`hc run --keep`,不佔側欄),並在 Herdr App 的排版加一個對話 tab「💬 主題」。關掉你這個 session、關掉 App 視窗都照跑 |
| `run <state.json>` | 就在目前這個 terminal 主持(前景,會一直跑)。沒有 herdr-core 時用 |
| `list --repo <主 repo>` | 這個 repo 的討論(JSON) |
| `new … --members '<只有一個>' --direct [--act]` | **一般對話**:只跟那一個 agent 對話,不經主席(Owner 說一句、它答一句,然後等 Owner);沒有輪數上限。`--act` = 它可以改檔、跑指令(預設只能讀);之後用 `set <state.json> act=true|false` 開關。再 `invite` 一個人就變回主席制 |
| `say <state.json> <文字>` | 替 Owner 發言。`@成員` = 他下一個發言(不經主席);`/stop` = 中止現在這一輪;`/end` = 請主席現在寫結論 |
| `invite <state.json> '<成員 JSON>'` | 中途加人 |
| `set <state.json> allow_yolo=false` / `max_rounds=20` / `chair_agent=codex` / `chair_model=haiku` | 改設定(換來源時,模型回到那個來源的預設) |
| `sources` | 這台的 PATH 有哪幾個來源的 CLI(JSON) |
| `card <state.json> 0,2` | 把結論裡第 0、2 項待辦開成 Tide 卡(要這台有 Tide) |
| `quit <state.json>` | 主持程式離開(紀錄留著,之後 `start` 接著跑) |

成員 JSON:`{"name": "api", "space": "api", "cwd": "/abs/path/api", "machine": null, "agent": "claude", "model": null}`

- `cwd` 必填,是**那台機器上**的絕對路徑;`machine` 是 `hc machine ls` 裡的名字(本機就不寫);`agent` 是模型來源:`claude`(預設)、`codex`、`gemini`(跑的是 `agy`)。`model` 選填,是那個 CLI 的模型名,不寫就用它的預設;使用者沒指定就不要自己填。
- `fork`(選填,只有 Claude):一個 Claude Code session 編號。那位成員第一次發言時用 `--resume <fork> --fork-session` 帶著那段對話進來,不影響原本的 session。
- 找成員:`hc ls --json` 每個 terminal 有 `cwd`;位址帶 `laptop/` 這種前綴的就是那台機器。使用者只說 repo 名時,先確認資料夾在哪,別猜。

## 流程與權限

1. 每一輪:收 Owner 的訊息 → 主席(沒有任何工具)輸出 `{say, next, ask, yolo, done, reason}`(`say` = 主席自己要說的話,可以空;寫在點名那一則的前面) → 那位成員發言 → 寫進紀錄。
2. 成員**預設唯讀**:Claude 只有讀檔、搜尋、查網頁的工具,不載 MCP;Codex 是唯讀沙箱;Gemini(agy)用只對那一次有效的 deny 規則擋寫檔、指令與 MCP(agy 要支援 `--settings`,太舊會直接失敗);真的看到它寫了檔 / 跑了指令,主持程式也會中止那一輪並記在紀錄裡。
3. 主席判斷大家已經談定要動手時,可以讓**一個成員的一輪**開 YOLO(不問權限,可改檔、跑指令,在他自己的資料夾裡)。紀錄會有一行 `🔓 主席授權 <成員> YOLO:<理由>`;下一輪就收回。`--no-yolo` 或 `set allow_yolo=false` 會把這個權力關掉。
4. 到輪數上限、主席說 `done`、或 Owner `/end` → 主席寫結論(決定 / 還沒談定 / 待辦),待辦存進 `todos`。**待辦不會自己變成卡**,要 Owner 說了才 `card`。
5. 結束後 Owner 再發言,討論會重新開始(至少再給 6 輪)。

## 看進度

- 讀 `<主題>.md` 的最後幾則;`<主題>.json` 的 `status`、`round`、`now`。
- `runner` 是 `null`、或它的 `at` 超過 30 秒沒更新 → 沒有人在主持,`start` 一次。
- 一輪大約 10 到 60 秒(每次發言都重新啟動一次 agent)。要等就等紀錄長出新的一則,不要每秒去讀。

## 紅線

- **YOLO 是讓別的 agent 不問權限動手**。開討論前跟使用者確認要不要允許;使用者沒說就照預設(允許,但由主席判斷),並在回報裡講清楚「主席可以授權成員動手」。成員的資料夾裡有不能動的東西時,用 `--no-yolo`。
- 你是替 Owner 傳話:`say` 的內容照使用者的意思寫,不要自己加戲、不要替他做決定(`/end`、`card`、`allow_yolo` 都是他的決定)。
- 你自己如果是被邀進討論的成員(你的提示裡會寫「你被邀請進一場多 agent 討論」),**不要**再呼叫這些指令:你的回答會由主持程式貼進紀錄。
- `quit`、`hc kill` 只對這場討論自己的主持程式做;不要動別的 terminal。
- 別台機器的成員走 `hc exec`,一輪最多 10 分鐘;那台要裝好該成員的 CLI(`claude` / `codex` / `agy`)並登入。
