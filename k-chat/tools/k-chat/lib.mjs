// k-chat (herdr-essentials, ADR 0004): the parts of the discussion runner that don't start
// programs: the record's format, what the Owner's messages mean, the prompts, the arguments
// each member's agent is started with. runner.mjs does the turns.
import fs from "node:fs";
import path from "node:path";

export const READ_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";
export const TAIL = 60000; // characters of the record a prompt carries at most

// Where a member (or the chair) gets its model from: the CLI that is started for it.
export const SOURCES = {
  claude: { label: "Claude", bin: "claude", chair: "sonnet" },
  codex: { label: "Codex", bin: "codex", chair: null },
  gemini: { label: "Gemini", bin: "agy", chair: null }, // Google's Antigravity CLI
};
export function source(name) {
  const n = String(name || "claude").toLowerCase();
  const id = n === "agy" ? "gemini" : n === "claude-code" ? "claude" : n;
  if (!Object.hasOwn(SOURCES, id)) throw new Error(`不認得的模型來源:${name}(有 ${Object.keys(SOURCES).join("、")})`);
  return id;
}
// A model's name as the CLI takes it, null for the CLI's own default. It becomes an argument
// (on Windows through cmd for an npm-installed CLI), so nothing but a name gets through.
export function modelName(m) {
  const t = String(m ?? "").trim();
  if (!t) return null;
  if (!/^[A-Za-z0-9][\w.:/@+[\]-]{0,79}$/.test(t)) throw new Error(`模型名字不對:${t}`);
  return t;
}
export const sourceLabel = (x) => `${SOURCES[source(x?.agent)].label}${x?.model ? ` ${x.model}` : ""}`;

const two = (n) => String(n).padStart(2, "0");
export const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}`;
export const day = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// A topic as a file name, letters, digits, - and _ only (porthole's #chat opens no other name; the
// topic itself is the record's H1). A topic with none of them: chat-<date>-<time>.
export function slug(topic, d = new Date()) {
  if (!String(topic ?? "").trim()) throw new Error("主題不能是空的");
  const s = String(topic).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return (/[A-Za-z0-9]/.test(s) ? s : `chat-${stamp(d)}`).slice(0, 80);
}
export const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
// A heading's time: ISO in the record (as porthole writes it), HH:MM on screen. Older records have HH:MM.
export const shown = (at) => { const t = Date.parse(at); return Number.isNaN(t) ? String(at ?? "") : clock(new Date(t)); };

// Where one discussion's files are: the record, its state, the Owner's inbox.
export function files(repo, topic) {
  const base = path.join(repo, "doc", "chat", slug(topic));
  return { md: `${base}.md`, json: `${base}.json`, inbox: `${base}.inbox` };
}
export const filesOf = (statePath) => {
  const base = statePath.replace(/\.json$/, "");
  return { md: `${base}.md`, json: statePath, inbox: `${base}.inbox` };
};

// Members as given ({ name?, space, machine?, cwd, agent?, fork? }) with unique names.
export function members(list, taken = []) {
  const used = new Set(taken);
  return (list ?? []).map((m) => {
    if (!m?.cwd) throw new Error(`成員 ${m?.name ?? m?.space ?? "?"} 沒有資料夾(cwd)`);
    let name = String(m.name || m.space || path.basename(m.cwd)).replace(/[\s@]+/g, "-");
    if (used.has(name) && m.machine) name = `${name}-${m.machine}`;
    for (let i = 2, base = name; used.has(name); i += 1) name = `${base}-${i}`;
    used.add(name);
    const agent = source(m.agent);
    if (m.fork && agent !== "claude") throw new Error(`成員 ${name}:帶入對話(fork)只支援 Claude`);
    return { name, space: m.space || name, machine: m.machine || null, cwd: m.cwd, agent, model: modelName(m.model), session: null, fork: m.fork || null, seen: 0 };
  });
}

// direct: a plain conversation, the Owner and one agent, no chair (a second member brings the chair back).
// act: in a direct conversation, whether that agent may change files and run commands (the Owner's switch).
export function newState({ repo, topic, title, space, list, chairAgent, chairModel, maxRounds, allowYolo, direct, act }) {
  const agent = source(chairAgent);
  if (direct && (list ?? []).length !== 1) throw new Error("一般對話要剛好一個 agent");
  return {
    direct: Boolean(direct), act: Boolean(direct && act),
    k_chat: 1, topic: slug(topic), title: title || topic, repo, space: space || path.basename(repo),
    chair: { agent, model: modelName(chairModel) ?? SOURCES[agent].chair }, allow_yolo: allowYolo !== false, max_rounds: Number(maxRounds) > 0 ? Number(maxRounds) : 12,
    round: 0, status: "running", now: { phase: "idle", who: null, since: Date.now() },
    members: members(list), queue: [], todos: [], failures: 0, runner: null,
  };
}

// The record, in porthole's #chat format: "# <title>", then "## 🧑 Human · <ISO>" / "## 🤖 Assistant · <ISO>"
// turns; who spoke comes between the role and the time. Either side may append to the same file.
export const header = (s, d = new Date()) => s.direct
  ? `# ${s.title}\n\n> k-chat 一般對話 · 開始於 ${day(d)} ${clock(d)} · 對象:${s.members.map((m) => `${m.name}@${m.space}(${sourceLabel(m)})`).join("、")}\n`
  : `# ${s.title}\n\n> k-chat 討論群 · 開始於 ${day(d)} ${clock(d)} · 主席 ${sourceLabel(s.chair)} · 成員:${s.members.map((m) => `${m.name}@${m.space}(${sourceLabel(m)})`).join("、") || "(還沒有)"}\n`;
export const entry = (who, text, d = new Date()) => {
  const head = who === "owner" ? "🧑 Human" : who === "chair" ? "🤖 Assistant · 🪑 主席" : `🤖 Assistant · ${who.name}@${who.space}`;
  // What someone said can't start a new message: its own # and ## headings go down to ###.
  return `\n## ${head} · ${d.toISOString()}\n\n${String(text).trim().replace(/^#{1,2}(?=\s)/gm, "###")}\n`;
};
export const actLine = (name, on) => (on ? `🔓 Owner 允許 ${name} 動手(改檔、跑指令),到關掉為止。` : `🔒 Owner 收回了 ${name} 動手的權限:只能讀。`);
// A direct conversation's next turn: whoever the Owner is talking to answers what he just said.
export const directTurn = (s) => ({ next: (s.members.find((m) => m.name === s.last) ?? s.members[0])?.name ?? "owner", ask: "", yolo: false, done: false, reason: "", from: "owner" });
export const yoloLine = (name, reason) => `🔓 主席授權 ${name} YOLO:${String(reason || "要動手實作").replace(/\s+/g, " ").trim()}`;

// The record as messages, for the mod: [{ role: "owner" | "chair" | "member", who, time, text }].
export function messages(record) {
  const out = [];
  const re = /^## (🧑 Human|🤖 Assistant)([^\n]*)$/gm;
  const heads = [...String(record ?? "").matchAll(re)];
  heads.forEach((h, i) => {
    const rest = h[2].split("·").map((x) => x.trim()).filter(Boolean);
    const time = shown(rest.length ? rest[rest.length - 1] : "");
    const label = rest.slice(0, -1).join(" · ");
    const role = h[1].startsWith("🧑") ? "owner" : label.includes("主席") ? "chair" : "member";
    const end = i + 1 < heads.length ? heads[i + 1].index : record.length;
    out.push({ role, who: role === "owner" ? "Owner" : role === "chair" ? "主席" : label || "Assistant", time, text: record.slice(h.index + h[0].length, end).trim() });
  });
  return out;
}

// A record's title: its H1 (before the first turn), else the fallback. Whether it has turns at all
// (porthole lists only those; a note written into doc/chat has none).
export function titleOf(record, fallback) {
  const t = String(record ?? ""), first = t.search(/^## /m), head = first === -1 ? t : t.slice(0, first);
  return /^# (.+)$/m.exec(head)?.[1]?.trim() || fallback;
}
export const hasTurns = (record) => /^## (🧑 (?:Human|You)|🤖 (?:Assistant|Claude))/m.test(String(record ?? ""));

// What an Owner message asks of the runner, besides being said.
//   /stop: end the turn that is running and wait.  /end: have the chair conclude now.
//   @name: that member speaks next (in the order named).
export function parseSay(text, names) {
  const t = String(text ?? "").trim();
  const cmd = /^\/(stop|end)(?![\w-])/i.exec(t)?.[1]?.toLowerCase() ?? null;
  const mentions = [];
  for (const m of t.matchAll(/@([^\s@,,。:：、;;!!??]+)/g)) if (names.includes(m[1]) && !mentions.includes(m[1])) mentions.push(m[1]);
  return { text: t, stop: cmd === "stop", end: cmd === "end", mentions };
}

const tail = (text) => (text.length > TAIL ? `…(前面省略 ${text.length - TAIL} 字)\n${text.slice(-TAIL)}` : text);
const roster = (s) => s.members.map((m) => `- ${m.name}:Space「${m.space}」,${m.machine ? `機器 ${m.machine}` : "本機"},資料夾 ${m.cwd}(${sourceLabel(m)})`).join("\n");

export const CHAIR_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", description: "你自己要對大家說的話(回應 Owner、整理分歧、指出漏掉的點、你的看法);沒有就給空字串" },
    next: { type: "string", description: "下一個發言的成員名字;要等 Owner 回話就填 owner" },
    ask: { type: "string", description: "要問他什麼,或要他做什麼" },
    yolo: { type: "boolean", description: "這一輪讓他動手改檔 / 跑指令" },
    done: { type: "boolean", description: "討論可以結束了" },
    reason: { type: "string", description: "一句話:為什麼是他、為什麼開 YOLO、或為什麼結束" },
  },
  required: ["say", "next", "ask", "yolo", "done", "reason"], additionalProperties: false,
};
export const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string", description: "Markdown:決定、還沒談定的、待辦與負責人" },
    todos: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, repo: { type: "string", description: "負責的成員的 Space / repo 名" }, detail: { type: "string" } },
      required: ["title", "repo", "detail"], additionalProperties: false } },
  },
  required: ["conclusion", "todos"], additionalProperties: false,
};

export function chairPrompt(s, record) {
  return `你是「${s.title}」這場多 agent 討論的主席。Owner(人)主持,你決定每一輪誰發言,自己也可以說話。

成員:
${roster(s)}

規則:
- 你自己的話寫在 say:回應 Owner 剛說的、整理目前的共識與分歧、指出大家漏掉的點、或講你自己的看法。簡短(三句以內),不要重述成員剛講過的內容;沒有要說的就留空字串,不必每一輪都講;done: true 那一輪不用寫(接著就寫結論)。你沒有任何工具、讀不到檔案:要查證的事交給成員,不要講得像你查過。
- Owner 問的事你自己就答得了(不需要讀任何 repo),就在 say 回答,next 填 "owner"。
- 一次只點一個人。挑最能推進討論的:被問到的、有那個 repo 的知識的、還沒表態的。不要讓同一個人連講三輪。
- Owner 的話優先:他剛說了什麼,下一輪就先處理那件事。
- 需要 Owner 決定或補資料時,next 填 "owner",ask 寫要他回答什麼,然後等他。
- 成員預設只能讀(讀檔、搜尋、查網頁)。${s.allow_yolo
    ? "只有在大家已經談定要動手、而且動手的範圍講清楚了,才把 yolo 設成 true:那個成員這一輪可以改檔、跑指令(在他自己的資料夾裡),下一輪就收回。reason 要寫清楚授權的理由。拿不準就不要開。"
    : "Owner 關掉了 YOLO:yolo 一律 false。"}
- 該談的談完了、或大家開始重複,就 done: true。done: true 是現在就結束,next 那個人不會再發言;還要他講就先 done: false。
- 現在是第 ${s.round + 1} 輪,上限 ${s.max_rounds} 輪。

目前的對話紀錄:
<record>
${tail(record)}
</record>

輸出下一輪的安排。`;
}

export function concludePrompt(s, record) {
  return `你是「${s.title}」這場多 agent 討論的主席。討論結束了,請寫結論。

成員:
${roster(s)}

對話紀錄:
<record>
${tail(record)}
</record>

conclusion 用繁體中文 Markdown,依序三段:「決定」(談定了什麼)、「還沒談定」(沒有就寫無)、「待辦」(每項誰負責)。只寫紀錄裡有的,不要補充沒人說過的事。
todos 把待辦逐項列出:title 一句話,repo 填負責的成員的 Space 名,detail 寫要做什麼、做到什麼算完成。沒有待辦就給空陣列。`;
}

// What a member is told: the rules once, then what was said since it last spoke, then the ask.
export function memberPrompt(s, m, record, turn) {
  const first = !m.session;
  const since = record.slice(Math.min(m.seen ?? 0, record.length));
  if (s.direct) {
    const rules = `Owner(人)要跟你對話,主題「${s.title}」。你的名字是 ${m.name}(Space「${m.space}」,你在自己的資料夾 ${m.cwd} 裡)。只有你和他,沒有別的成員。

怎麼回答:
- 你的回答會原樣寫進對話紀錄(doc/chat 底下的 Markdown),所以直接講內容,不要寒暄、不要重述問題。
- 用繁體中文,先講結論,再講依據。需要的話先讀你資料夾裡的檔案再回答,引用時寫出檔案路徑。不知道就說不知道。
`;
    return `${first ? `${rules}\n` : ""}${first ? "到目前為止的對話紀錄" : "你上次回答之後的對話紀錄"}:
<record>
${tail(since) || "(沒有新的)"}
</record>

回答 Owner 上面說的話。
${turn.yolo ? "\nOwner 允許你動手:可以改檔、跑指令,只做他要求的範圍,做完回報改了哪些檔。" : "\n你現在只能讀(讀檔、搜尋、查網頁),不要嘗試改檔或跑指令;Owner 要你動手時,告訴他先把「可動手」打開。"}`;
  }
  const intro = `你被邀請進一場多 agent 討論「${s.title}」,你的名字是 ${m.name}(Space「${m.space}」,你在自己的資料夾 ${m.cwd} 裡)。Owner(人)主持,主席決定誰發言。

成員:
${roster(s)}

怎麼參與:
- 輪到你才發言。你的回答會原樣貼進對話紀錄給所有人看,所以直接講內容,不要寒暄、不要重述問題。
- 用繁體中文,簡短:先講結論,再講依據。需要的話先讀你資料夾裡的檔案再回答,引用時寫出檔案路徑。
- 不知道就說不知道;該別的成員回答的事,點名他。
- 預設你只能讀。主席明說這一輪授權你動手(YOLO)時,才改檔或跑指令,做完回報改了什麼。
`;
  return `${first ? `${intro}\n` : ""}${first ? "到目前為止的對話紀錄" : "你上次發言之後的對話紀錄"}:
<record>
${tail(since) || "(沒有新的)"}
</record>

${turn.from === "owner" ? "Owner 點名你回答上面他說的話。" : `主席問你:${turn.ask}`}
${turn.yolo ? "\n主席授權你這一輪動手(YOLO):可以改檔、跑指令,只做被要求的範圍,做完回報改了哪些檔。" : "\n這一輪只能讀,不要嘗試改檔或跑指令。"}`;
}

// The agent's arguments for one turn. Read-only by default; YOLO for that turn only.
//   Claude: only the reading tools exist. Codex: its read-only sandbox (exec's own flags go before
//   `resume`, which doesn't take --sandbox). Gemini (agy): deny rules for this run only, which win over
//   its agent mode (its default one edits files). An agy without --settings refuses to start. guard()
//   ends the turn when a write or a command went through anyway.
export function memberArgv(m, yolo) {
  const agent = source(m.agent), model = m.model ? ["--model", m.model] : [];
  if (agent === "codex") {
    const mode = yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"];
    return { agent, bin: "codex", args: ["exec", "--json", "--skip-git-repo-check", ...mode, ...model, ...(m.session ? ["resume", m.session] : []), "-"] };
  }
  if (agent === "gemini") {
    const mode = yolo ? ["--dangerously-skip-permissions"] : AGY_READ;
    return { agent, bin: "agy", args: [...AGY, ...mode, ...model, ...(m.session ? ["--conversation", m.session] : [])], guard: yolo ? null : guard };
  }
  const args = ["-p", "--output-format", "json", ...model];
  if (m.session) args.push("--resume", m.session);
  else if (m.fork) args.push("--resume", m.fork, "--fork-session");
  if (yolo) args.push("--dangerously-skip-permissions");
  else args.push("--tools", READ_TOOLS, "--allowedTools", READ_TOOLS, "--strict-mcp-config");
  return { agent, bin: "claude", args };
}
// agy reads the prompt on stdin only as stream-json (as an argument, a long record would not fit).
const AGY = ["--input-format", "stream-json", "--output-format", "stream-json"];
// Not `"toolPermission":"strict"`: that refuses reading too. Not `"agentMode":""`: that still writes.
const agyDeny = (...more) => ["--sandbox", "--settings", JSON.stringify({ permissions: { deny: ["write_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)", "download_url(*)", ...more] } })];
const AGY_READ = agyDeny(), AGY_CHAIR = agyDeny("read_file(*)", "read_url(*)"); // a chair that may read goes through files for minutes

// The chair: no tools (Claude), nothing it may read or change (Gemini), nothing it may change (Codex). `schemaFile` holds the schema for Codex.
export function chairArgv(chair, schema, schemaFile) {
  const agent = source(chair?.agent), model = chair?.model ? ["--model", chair.model] : [];
  if (agent === "codex") return { agent, bin: "codex", args: ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", ...model, "--output-schema", schemaFile, "-"] };
  if (agent === "gemini") return { agent, bin: "agy", args: [...AGY, ...AGY_CHAIR, ...model, "--json-schema", JSON.stringify(schema)], guard };
  return { agent, bin: "claude", args: ["-p", "--output-format", "json", ...model, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--json-schema", JSON.stringify(schema)] };
}

// The prompt as the agent's stdin takes it.
export const feed = (agent, prompt) => (agent === "gemini" ? `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` : prompt);

const event = (line) => { try { return JSON.parse(line); } catch { return null; } };

// agy's output, line by line, in a read-only turn: why the turn must end, or null. (What `init` says
// about the mode is no help: permission_mode is "request-review" in Auto too.)
const WRITES = /write|replace|edit|sed_file|create|delete|remove|rename|run_command|run_workflow|notebook|send_command|execute|shell/i;
export function guard(line) {
  const e = event(line);
  const u = e?.event === "step_update" ? e.step_update : null;
  // A refused call carries an error; one that isn't DONE yet may still be refused.
  if (u?.step_type === "tool" && u.state === "DONE" && WRITES.test(u.tool_name ?? "") && !u.tool_info?.error) return `唯讀輪裡 agy 跑了 ${u.tool_name},這一輪作廢(請檢查它的資料夾)`;
  return null;
}

// What the agent printed, as { text, session, structured }.
export function parseReply(agent, stdout) {
  const out = String(stdout ?? "").trim();
  if (agent === "codex") {
    let text = "", session = null, failed = null;
    for (const line of out.split("\n")) {
      const e = event(line);
      if (e?.type === "thread.started" && e.thread_id) session = e.thread_id;
      if (e?.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) text = e.item.text;
      if (e?.type === "turn.failed") failed = e.error?.message ?? "turn.failed";
    }
    if (failed) throw new Error(`Codex:${String(failed).slice(0, 500)}`);
    if (!text) throw new Error(`Codex 沒有回答:${out.slice(-300)}`);
    return { text, session, structured: null };
  }
  if (agent === "gemini") {
    const r = out.split("\n").map(event).filter((e) => e?.event === "result").pop()?.result;
    if (!r) throw new Error(`讀不懂 agy 的輸出:${out.slice(-300) || "(空的)"}`);
    if (r.status !== "SUCCESS") throw new Error(`Gemini(agy):${String(r.error || r.status).slice(0, 500)}${/authenticat/i.test(r.error ?? "") ? "(先在那台機器跑一次 agy 登入)" : ""}`);
    return { text: String(r.response ?? "").trim(), session: r.conversation_id || null, structured: r.structured_output ?? null };
  }
  // Something may be printed before the JSON (a shell banner on another machine): take the last JSON line.
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{")) ?? out;
  let r; try { r = JSON.parse(line); } catch { throw new Error(`讀不懂 agent 的輸出:${out.slice(-300) || "(空的)"}`); }
  if (r.is_error) throw new Error(String(r.result || r.subtype || "agent 回報錯誤").slice(0, 500));
  return { text: String(r.result ?? ""), session: r.session_id ?? null, structured: r.structured_output ?? null };
}
// A reply that had a schema, as its object (some print it as text, maybe fenced).
export function structured(r) {
  if (r.structured) return r.structured;
  const t = String(r.text ?? ""), from = t.indexOf("{"), to = t.lastIndexOf("}");
  try { return JSON.parse(t.slice(from, to + 1)); } catch { throw new Error(`主席的回答不是 JSON:${t.slice(0, 200) || "(空的)"}`); }
}

// The chair's answer made safe: a member that exists, YOLO only when allowed.
export function turnFrom(s, c, last) {
  const names = s.members.map((m) => m.name);
  const done = Boolean(c?.done);
  let next = String(c?.next ?? "").replace(/^@/, "").trim();
  if (!done && next.toLowerCase() !== "owner" && !names.includes(next)) {
    // Not a member: whoever follows the last speaker.
    next = names[(names.indexOf(last) + 1) % names.length] ?? "owner";
  }
  return { say: String(c?.say ?? "").trim(), next: next.toLowerCase() === "owner" ? "owner" : next, ask: String(c?.ask ?? "").trim(), yolo: Boolean(c?.yolo) && s.allow_yolo && !done,
    done, reason: String(c?.reason ?? "").trim(), from: "chair" };
}

// State is written whole, by the runner only (everyone else writes to the inbox).
export function save(statePath, s) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, statePath);
}
export const load = (statePath) => {
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (s?.k_chat !== 1) throw new Error(`${statePath} 不是 k-chat 的討論`);
  return s;
};

// The inbox: one small JSON file per message, taken in name order.
export function drop(inbox, msg) {
  fs.mkdirSync(inbox, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(inbox, `.${name}`), JSON.stringify(msg));
  fs.renameSync(path.join(inbox, `.${name}`), path.join(inbox, name));
  return name;
}
export function peek(inbox) {
  let names = [];
  try { names = fs.readdirSync(inbox).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch {}
  const out = [];
  for (const name of names) {
    try { out.push({ name, msg: JSON.parse(fs.readFileSync(path.join(inbox, name), "utf8")) }); } catch { out.push({ name, msg: null }); }
  }
  return out;
}
export function take(inbox) {
  const out = [];
  for (const g of peek(inbox)) {
    const file = path.join(inbox, g.name);
    // Unreadable: still being written (the mod's write isn't a rename). Left for the next look,
    // thrown away once it is clearly not going to become JSON.
    if (!g.msg) { try { if (Date.now() - fs.statSync(file).mtimeMs < 5000) break; } catch {} }
    try { fs.unlinkSync(file); } catch {}
    if (g.msg) out.push(g.msg);
  }
  return out;
}
