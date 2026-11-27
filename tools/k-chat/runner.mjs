#!/usr/bin/env node
// k-chat runner (herdr-essentials, ADR 0004, Tide #293): hosts one multi-agent discussion.
// Each round: take the Owner's messages, ask the chair who speaks, run that member's agent
// headless in its own folder (on its own machine), write the answer to doc/chat/<topic>.md.
//
//   runner.mjs new --repo DIR --topic NAME --members JSON [--title T] [--space S] [--say TEXT]
//                  [--max-rounds N] [--chair-agent claude|codex|gemini|hermes] [--chair-model M] [--chair-machine NAME] [--no-yolo]
//                  (--chair-machine: the chair answers on that machine through hc exec; the record stays here)
//                  [--direct [--act]]   --direct: a plain conversation with the one member, no chair;
//                                      --act: that agent may change files and run commands
//                                      make the files, print the state path
//   runner.mjs list --repo DIR         that repo's discussions, as JSON, newest first (with porthole's
//                                      conversations there: { md, porthole: true })
//   runner.mjs adopt <name.md> --members JSON [--space S]   take on a conversation porthole started, as a
//                                      plain conversation with that one member; print the state path
//   runner.mjs start <state.json> [--no-layout]   host it in a herdr-core terminal of its own (hc run --keep); the
//                                      discussion gets a tab in the Herdr App unless --no-layout (the mod makes it)
//   runner.mjs run <state.json>        host it here, in this terminal (picks up where it stopped)
//   runner.mjs say <state.json> TEXT   the Owner speaks (/stop, /end, @member)
//   runner.mjs invite <state.json> JSON   add a member: { name?, space, machine?, cwd, agent?, model?, fork? }
//                                      agent: claude (default) | codex | gemini (the agy CLI)
//   runner.mjs set <state.json> allow_yolo=false|max_rounds=20|chair_agent=codex|chair_model=haiku|act=true
//   runner.mjs sources                 which of those CLIs this machine has, as JSON
//   runner.mjs card <state.json> 0,2   open Tide cards for those to-dos of the conclusion
//   runner.mjs quit <state.json>       the runner leaves (the record stays)
//
// Only the runner writes the state and the record; everything else goes through the inbox
// (doc/chat/<topic>.inbox/), so a window can close and open again without losing anything.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./lib.mjs";

const BIN = { claude: process.env.K_CHAT_CLAUDE || "claude", codex: process.env.K_CHAT_CODEX || "codex", agy: process.env.K_CHAT_AGY || "agy", hermes: process.env.K_CHAT_HERMES || "hermes" };
const HC = process.env.K_CHAT_HC || "hc";
const TICK = Number(process.env.K_CHAT_TICK) || 1000;
const REOPEN = 6; // rounds an Owner message adds to a discussion that had ended

// A child's environment: not this terminal's tmux or Claude Code session.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "TMUX" || k === "TMUX_PANE" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

// Where a program is on this machine's PATH, or null.
function which(bin) {
  if (/[\\/]/.test(bin)) return fs.existsSync(bin) ? bin : null;
  const exts = process.platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) for (const x of exts) {
    const f = path.join(dir, bin + x);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

// Runs one program to its end with `input` on stdin. `stop()` is asked every tick: true ends it.
// `guard(line)` sees every line it prints: a reason ends it (a read-only turn that isn't).
// On another machine it goes through herdr-core (hc exec), which caps a run at 10 minutes.
function run({ bin, args, cwd, machine, input, timeout, stop, guard }) {
  const real = BIN[bin] ?? bin;
  // npm's CLIs are .cmd files on Windows, which only start through cmd (the arguments are ours: flags, names, a path).
  const found = !machine && process.platform === "win32" ? which(real) : null;
  const shell = Boolean(found?.toLowerCase().endsWith(".cmd"));
  const q = (x) => (/[\s&()^]/.test(x) ? `"${x}"` : x);
  const [cmd, argv] = shell ? [q(found), args.map(q)] : machine
    ? [HC, ["exec", "--on", machine, ...(cwd ? ["--cwd", cwd] : []), "--timeout", String(Math.min(600, Math.ceil(timeout / 1000))), "-i", "--", real, ...args]]
    : [real, args];
  return new Promise((resolve) => {
    let out = "", err = "", stopped = false, over = false, broke = null, seen = 0;
    const child = spawn(cmd, argv, { cwd: machine ? undefined : cwd, env: childEnv(), shell, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const end = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } };
    const timer = setInterval(() => { if (stop?.()) { stopped = true; end(); } }, TICK);
    const limit = setTimeout(() => { over = true; end(); }, timeout);
    current = end;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      if (!guard || broke) return;
      for (let nl = out.indexOf("\n", seen); nl >= 0 && !broke; nl = out.indexOf("\n", seen)) { broke = guard(out.slice(seen, nl)); seen = nl + 1; }
      if (broke) end();
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err += String(e?.message ?? e); });
    child.on("close", (code) => {
      clearInterval(timer); clearTimeout(limit); current = null;
      resolve({ code: code ?? 1, stdout: out, stderr: err, stopped, over, broke });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
let current = null; // ends the program that is running now

class Stopped extends Error {}

async function agent(spec, opts) {
  const r = await run({ ...spec, ...opts, input: L.feed(spec.agent, opts.input) });
  if (r.stopped) throw new Stopped();
  if (r.over) throw new Error(`超過 ${Math.round(opts.timeout / 60000)} 分鐘沒講完`);
  if (r.broke) throw new Error(r.broke);
  if (/not defined: -settings/.test(r.stderr)) throw new Error("那台的 agy 太舊(沒有 --settings),唯讀輪不跑。請更新 agy");
  try { return L.parseReply(spec.agent, r.stdout); }
  catch (e) { throw new Error(r.code !== 0 ? `${e.message}${r.stderr.trim() ? ` · ${r.stderr.trim().slice(-300)}` : ""}` : e.message); }
}

function host(statePath) {
  const f = L.filesOf(statePath);
  let s = L.load(statePath);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (s.runner?.pid && s.runner.pid !== process.pid && s.runner.host === os.hostname() && alive(s.runner.pid) && Date.now() - (s.runner.at ?? 0) < 30000) {
    console.error(`這場討論已經有主持程式在跑(pid ${s.runner.pid})`);
    process.exit(3);
  }
  fs.mkdirSync(f.inbox, { recursive: true });
  if (!fs.existsSync(f.md)) fs.writeFileSync(f.md, L.header(s));

  const record = () => fs.readFileSync(f.md, "utf8");
  const write = (who, text) => { fs.appendFileSync(f.md, L.entry(who, text)); console.log(`[${L.clock()}] ${who === "owner" ? "Owner" : who === "chair" ? "主席" : who.name}: ${String(text).trim().split("\n")[0].slice(0, 100)}`); };
  const beat = () => { s.runner = { pid: process.pid, host: os.hostname(), at: Date.now() }; L.save(statePath, s); };
  const now = (phase, who = null, yolo = false) => { s.now = { phase, who, yolo, since: Date.now() }; beat(); };
  const member = (name) => s.members.find((m) => m.name === name);
  const lastSpeaker = () => s.last ?? null;

  // The chair runs from an empty folder unless it is Claude (which gets no tools at all): the
  // others can't be started without theirs, so there is nothing there to read or change.
  // On another machine it starts in that machine's home (no --cwd): it has no tools there either.
  let desk = null;
  const chair = async (schema, prompt) => {
    const machine = L.machineName(s.chair.machine);
    let cwd = machine ? null : s.repo, file = null;
    if (L.source(s.chair.agent) === "codex" && machine) throw new Error(`Codex 不能在別台機器(${machine})當主席`);
    if (!machine && L.source(s.chair.agent) !== "claude") {
      cwd = desk ??= fs.mkdtempSync(path.join(os.tmpdir(), "k-chat-chair-"));
      fs.writeFileSync(file = path.join(cwd, "schema.json"), JSON.stringify(schema));
    }
    // Hermes takes no schema of its own: it gets it in the prompt, and structured() reads the JSON from its text.
    const src = L.source(s.chair.agent);
    const input = src === "claude" ? prompt
      : `${prompt}\n\n只根據上面的內容直接回答,不要使用任何工具。${src === "hermes" ? `\n只輸出一個符合這個 JSON Schema 的 JSON 物件,前後不要有其他文字:\n${JSON.stringify(schema)}` : ""}`;
    return L.structured(await agent(L.chairArgv(s.chair, schema, file), { cwd, machine, input, timeout: 5 * 60000, stop: stopAsked }));
  };

  const pulse = setInterval(beat, 5000);
  const leave = (code) => { clearInterval(pulse); current?.(); if (desk) fs.rmSync(desk, { recursive: true, force: true }); s.runner = null; s.now = { phase: "idle", who: null, since: Date.now() }; L.save(statePath, s); process.exit(code); };
  process.on("SIGTERM", () => leave(0));
  process.on("SIGINT", () => leave(0));

  // /stop waiting in the inbox ends the turn that is running.
  const stopAsked = () => L.peek(f.inbox).some((g) => g.msg?.type === "say" && L.parseSay(g.msg.text, []).stop);

  // Everything waiting in the inbox, in order. Returns { end, quit }.
  function inbox() {
    const got = { end: false, quit: false };
    for (const msg of L.take(f.inbox)) {
      if (msg.type === "quit") got.quit = true;
      else if (msg.type === "invite") {
        try {
          const [m] = L.members([msg.member], s.members.map((x) => x.name));
          m.seen = 0; s.members.push(m);
          // A second member: no longer a plain conversation, the chair takes the turns from here.
          const was = s.direct && s.members.length > 1;
          if (was) { s.direct = false; s.act = false; s.max_rounds = Math.max(s.max_rounds, s.round + REOPEN); }
          write("chair", `➕ ${m.name}@${m.space} 加入討論(${L.sourceLabel(m)}${m.machine ? `,機器 ${m.machine}` : ""})。${was ? "\n\n不再是一對一:接下來由主席點名,成員只能讀(要動手由主席授權)。" : ""}`);
        } catch (e) { write("chair", `⚠️ 邀請失敗:${e.message}`); }
      } else if (msg.type === "set") {
        if (typeof msg.allow_yolo === "boolean") { s.allow_yolo = msg.allow_yolo; write("chair", msg.allow_yolo ? "🔐 Owner 允許主席開 YOLO。" : "🔒 Owner 關掉了主席開 YOLO 的權力。"); }
        if (Number(msg.max_rounds) > 0) s.max_rounds = Number(msg.max_rounds);
        if (typeof msg.act === "boolean") {
          if (!s.direct) write("chair", "⚠️ 「可動手」只用在一般對話;討論群由主席授權(YOLO)。");
          else if (msg.act !== Boolean(s.act)) { s.act = msg.act; write("chair", L.actLine(s.members[0]?.name ?? "agent", s.act)); }
        }
        if (msg.chair_agent || typeof msg.chair_model === "string") {
          try {
            const was = L.source(s.chair.agent), to = msg.chair_agent ? L.source(msg.chair_agent) : was;
            // Another source: its own default model unless one was named.
            const model = (typeof msg.chair_model === "string" ? L.modelName(msg.chair_model) : to === was ? s.chair.model : null) ?? L.SOURCES[to].chair;
            if (to !== was || model !== s.chair.model) { s.chair = L.chairOf(to, model, s.chair.machine); write("chair", `🪑 主席改用 ${L.chairLabel(s.chair)}。`); }
          } catch (e) { write("chair", `⚠️ 主席沒換成:${e.message}`); }
        }
      } else if (msg.type === "card") cards(msg.todos ?? []);
      else if (msg.type === "say" && String(msg.text ?? "").trim()) {
        const say = L.parseSay(msg.text, s.members.map((m) => m.name));
        write("owner", say.text);
        if (say.stop) { s.queue = []; s.status = "waiting"; continue; }
        if (say.end) { got.end = true; continue; }
        for (const name of say.mentions) s.queue.push({ next: name, ask: say.text, yolo: false, done: false, reason: "", from: "owner" });
        if (s.status === "done") { s.max_rounds = Math.max(s.max_rounds, s.round + REOPEN); s.todos = s.todos.filter((t) => t.card); }
        s.status = "running"; s.failures = 0;
      }
    }
    return got;
  }

  // Tide cards for the conclusion's to-dos the Owner picked (never on the chair's own say-so).
  function cards(picked) {
    const who = (() => { try { return JSON.parse(fs.readFileSync(path.join(s.repo, ".claude", "tide.json"), "utf8")).ap; } catch { return null; } })() || path.basename(s.repo);
    const made = [];
    for (const i of picked) {
      const t = s.todos[i];
      if (!t || t.card) continue;
      const m = s.members.find((x) => x.name === t.repo || x.space === t.repo);
      const repo = m ? m.cwd.split(/[\\/]/).filter(Boolean).pop() : t.repo;
      const body = `${t.detail}\n\n來源:k-chat 討論「${s.title}」的結論(\`${path.relative(s.repo, f.md)}\`,repo ${path.basename(s.repo)})。\n`;
      const r = spawnTask(["create", "--repo", repo, "--title", t.title, "--body-file", "-"], body, who);
      const id = /#(\d+)/.exec(r.stdout)?.[1];
      if (r.code === 0 && id) { t.card = Number(id); made.push(`#${id} ${t.title}(${repo})`); }
      else made.push(`⚠️ 沒開成「${t.title}」:${(r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 200) ?? "?"}`);
    }
    if (made.length) write("chair", `🗂 Owner 把待辦開成 Tide 卡:\n${made.map((x) => `- ${x}`).join("\n")}`);
  }

  async function conclude(why) {
    now("conclude");
    try {
      const c = await chair(L.CONCLUDE_SCHEMA, L.concludePrompt(s, record()));
      s.todos = [...s.todos.filter((t) => t.card), ...(c.todos ?? []).map((t) => ({ title: String(t.title), repo: String(t.repo), detail: String(t.detail), card: null }))];
      write("chair", `### 結論\n\n${why ? `> ${why}\n\n` : ""}${String(c.conclusion).trim().replace(/^#{1,3}(?=\s)/gm, "####")}`);
    } catch (e) {
      if (e instanceof Stopped) { s.status = "waiting"; write("chair", "⏹ Owner 中止了收尾,等 Owner 發言。"); return; }
      write("chair", `⚠️ 結論沒寫成:${e.message}`);
    }
    s.status = "done"; s.queue = [];
  }

  async function round() {
    let turn = s.queue.shift();
    if (!turn && s.direct) turn = L.directTurn(s);
    if (s.direct) turn = { ...turn, yolo: Boolean(s.act) };
    if (!turn) {
      now("chair");
      turn = L.turnFrom(s, await chair(L.CHAIR_SCHEMA, L.chairPrompt(s, record())), lastSpeaker());
      const say = turn.say ? `${turn.say}\n\n` : "";
      if (turn.done) return conclude(turn.reason);   // its own words would only repeat the conclusion that follows
      if (turn.next === "owner") { write("chair", `${say}→ **@Owner**:${turn.ask}${turn.reason ? `\n\n> ${turn.reason}` : ""}`); s.status = "waiting"; return; }
      write("chair", `${say}→ **@${turn.next}**:${turn.ask}${turn.reason && !turn.yolo ? `\n\n> ${turn.reason}` : ""}${turn.yolo ? `\n\n${L.yoloLine(turn.next, turn.reason)}` : ""}`);
    }
    const m = member(turn.next);
    if (!m) return;
    now("member", m.name, turn.yolo);
    const text = record();
    const r = await agent(L.memberArgv(m, turn.yolo), { cwd: m.cwd, machine: m.machine, input: L.memberPrompt(s, m, text, turn), timeout: (turn.yolo ? 30 : 15) * 60000, stop: stopAsked });
    if (r.session) m.session = r.session;
    write(m, r.text || "(沒有回答)");
    m.seen = record().length; s.last = m.name; s.round += 1; s.failures = 0;
    if (s.direct && !s.queue.length) s.status = "waiting";   // answered: the Owner's turn
  }

  (async () => {
    console.log(`k-chat: 主持「${s.title}」 · ${f.md}`);
    for (;;) {
      const got = inbox();
      if (got.quit) { console.log("k-chat: Owner 關閉了主持程式"); leave(0); }
      try {
        if (got.end && s.status !== "done") await conclude("Owner 要求收尾");
        else if (s.status === "running" && !s.members.length) { write("chair", "還沒有成員:先邀請 agent 進來。"); s.status = "waiting"; }
        else if (s.status === "running" && !s.direct && s.round >= s.max_rounds && !s.queue.length) await conclude(`到了 ${s.max_rounds} 輪上限`);
        else if (s.status === "running") await round();
        else { now(s.status === "done" ? "done" : "waiting"); await new Promise((r) => setTimeout(r, TICK)); continue; }
      } catch (e) {
        if (e instanceof Stopped) { s.status = "waiting"; s.queue = []; write("chair", "⏹ Owner 中止了這一輪,等 Owner 發言。"); }
        else {
          s.failures = (s.failures ?? 0) + 1;
          const who = s.now?.phase === "member" ? s.now.who : "主席";
          write("chair", `⚠️ ${who} 這一輪失敗:${e.message}${s.failures >= 3 ? "\n\n連續失敗三次,先停下來等 Owner。" : ""}`);
          if (s.failures >= 3) { s.status = "waiting"; s.failures = 0; }
        }
      }
      now(s.status === "running" ? "idle" : s.status === "done" ? "done" : "waiting");
    }
  })();
}

function spawnTask(args, input, who) {
  const env = { ...childEnv(), TASK_WHO: who };
  const fake = process.env.K_CHAT_TASK;
  const r = fake
    ? spawnSync(fake, args, { input, env, encoding: "utf8" })
    : spawnSync("bash", ["-c", 'source ~/.config/tide/env && exec "$TIDE_HOME/bin/task" "$@"', "task", ...args], { input, env, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

// Puts the discussion in the Herdr App's layout (the core document "herdr-app": spaces → tabs): a
// tab with the k-chat mod on that state file, the same one the mod makes ("💬 <title>"), in the
// space whose folder it is, or in a new space. False when it is already there.
function place(statePath, folder, title) {
  const rpc = (method, params) => {
    const r = spawnSync(HC, ["connect"], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n", env: childEnv(), encoding: "utf8", timeout: 15000 });
    const res = JSON.parse((r.stdout ?? "").split("\n")[0] || "null");
    if (!res || res.error) throw new Error(`${method}: ${JSON.stringify(res?.error ?? (r.stderr || "沒有回應")).slice(0, 200)}`);
    return res.result;
  };
  const id = (prefix) => prefix + crypto.randomBytes(16).toString("hex");
  const cur = rpc("doc.get", { name: "herdr-app" });
  const value = cur.value ?? {}, spaces = [...(value.spaces ?? [])];
  if (JSON.stringify(spaces).includes(`"state":${JSON.stringify(statePath)}`)) return false;
  let sp = spaces.find((x) => x.folder === folder);
  if (!sp) { sp = { id: id("sp"), name: path.basename(folder) || folder, folder, tabs: [] }; spaces.push(sp); }
  const tab = id("tb");
  sp.tabs = [...(sp.tabs ?? []), { id: tab, name: `💬 ${title}`.slice(0, 40), root: { id: tab, type: "row", children: [{ id: id("pd"), type: "block", content: { mod: "k-chat", props: { state: statePath, space: sp.id } } }] } }];
  rpc("doc.set", { name: "herdr-app", value: { ...value, spaces }, version: cur.version });
  return true;
}

function flags(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-yolo") o.noYolo = true;
    else if (a === "--direct") o.direct = true;
    else if (a === "--act") o.act = true;
    else if (a === "--no-layout") o.noLayout = true;
    else if (a.startsWith("--")) { o[a.slice(2)] = argv[i + 1]; i += 1; }
    else o._.push(a);
  }
  return o;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = flags(rest);
  const statePath = o._[0] ? path.resolve(o._[0]) : null;
  const need = () => { if (!statePath) throw new Error(`用法:runner.mjs ${cmd} <state.json> …`); return L.filesOf(statePath); };
  switch (cmd) {
    case "new": {
      if (!o.repo || !o.topic) throw new Error("new 需要 --repo 與 --topic");
      // The file name is the topic's letters and digits; a name already taken (by k-chat or porthole) gets -2, -3, …
      const repo = path.resolve(o.repo), base = L.slug(o.topic);
      let name = base;
      for (let i = 2; fs.existsSync(L.files(repo, name).json) || fs.existsSync(L.files(repo, name).md); i += 1) name = `${base}-${i}`;
      const f = L.files(repo, name);
      const s = L.newState({ repo, topic: name, title: o.title || o.topic, space: o.space, list: JSON.parse(o.members || "[]"), chairAgent: o["chair-agent"], chairModel: o["chair-model"], chairMachine: o["chair-machine"], maxRounds: o["max-rounds"], allowYolo: !o.noYolo, direct: o.direct, act: o.act });
      if (s.direct && !o.say) s.status = "waiting";   // nothing said yet: the agent has nothing to answer
      fs.mkdirSync(f.inbox, { recursive: true });
      fs.writeFileSync(f.md, L.header(s));
      L.save(f.json, s);
      if (o.say) L.drop(f.inbox, { type: "say", text: o.say });
      console.log(f.json);
      break;
    }
    case "list": {
      // This repo's discussions, as JSON (the mod can't list a folder itself).
      // Conversations porthole's #chat started there (a record with turns, no state) come too, as
      // { md, porthole: true }: opening one adopts it (`adopt`).
      const dir = path.join(path.resolve(o.repo || "."), "doc", "chat"), out = [];
      let names = []; try { names = fs.readdirSync(dir).sort(); } catch {}
      for (const n of names.filter((x) => x.endsWith(".json"))) {
        try {
          const s = L.load(path.join(dir, n));
          out.push({ path: path.join(dir, n), title: s.title, status: s.status, direct: Boolean(s.direct), round: s.round, max: s.max_rounds, members: s.members.map((m) => m.name), sources: s.members.map((m) => L.sourceLabel(m)), at: fs.statSync(path.join(dir, n)).mtimeMs });
        } catch {}
      }
      for (const n of names.filter((x) => x.endsWith(".md") && !names.includes(x.replace(/\.md$/, ".json")))) {
        try {
          const md = path.join(dir, n), text = fs.readFileSync(md, "utf8");
          if (!L.hasTurns(text)) continue;
          out.push({ md, porthole: true, title: L.titleOf(text, n.replace(/\.md$/, "")), status: "waiting", direct: true, round: L.messages(text).length, members: [], sources: [], at: fs.statSync(md).mtimeMs });
        } catch {}
      }
      out.sort((a, b) => b.at - a.at);
      console.log(JSON.stringify(out));
      break;
    }
    case "adopt": {
      // A conversation porthole started (doc/chat/<name>.md, no state): k-chat takes it on as a plain
      // conversation with that Space's agent, record untouched. Its first turn reads the whole record.
      const md = path.resolve(o._[0] ?? ""), json = md.replace(/\.md$/, ".json");
      if (!md.endsWith(".md") || !fs.existsSync(md)) throw new Error(`沒有這個對話檔:${md}`);
      if (fs.existsSync(json)) { console.log(json); break; }
      const repo = path.resolve(path.dirname(md), "..", ".."), text = fs.readFileSync(md, "utf8");
      const s = L.newState({ repo, topic: path.basename(md, ".md"), title: L.titleOf(text, path.basename(md, ".md")), space: o.space, list: JSON.parse(o.members || "[]"), direct: true });
      s.status = "waiting"; s.round = L.messages(text).filter((m) => m.role !== "owner").length;
      fs.mkdirSync(L.filesOf(json).inbox, { recursive: true });
      L.save(json, s);
      console.log(json);
      break;
    }
    case "start": {
      // Hosts it in a herdr-core terminal of its own (it outlives this shell and the App's
      // windows), and puts the discussion in the Herdr App's layout as a tab.
      need();
      const s = L.load(statePath);
      const live = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (s.runner?.pid && s.runner.host === os.hostname() && live(s.runner.pid) && Date.now() - (s.runner.at ?? 0) < 30000) { console.log(JSON.stringify({ started: false, reason: "已經有主持程式在跑", pid: s.runner.pid })); break; }
      const name = `kchat-${crypto.createHash("sha1").update(statePath).digest("hex").slice(0, 8)}`;
      // The one from last time (ended, or the shell --keep left in its place) still holds the name.
      spawnSync(HC, ["kill", name], { env: childEnv(), encoding: "utf8" });
      spawnSync(HC, ["rm", name], { env: childEnv(), encoding: "utf8" });
      const r = spawnSync(HC, ["run", "--bg", "--keep", "--no-parent", "--json", "--name", name, "--cwd", s.repo, "--", process.execPath, fileURLToPath(import.meta.url), "run", statePath], { env: childEnv(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`hc run 失敗:${(r.stderr || r.stdout || String(r.error ?? "")).trim().split("\n").pop()}`);
      let address = null; try { address = JSON.parse(r.stdout.trim().split("\n").pop()).address ?? null; } catch {}
      let placed = false, warn = null;
      // The host's own terminal stays out of the sidebar. --no-layout: the mod makes the tab itself.
      try { placed = o.noLayout ? false : place(statePath, s.repo, s.title); } catch (e) { warn = `沒寫進 Herdr App 排版(${e.message});主持程式還是在跑:hc attach ${name}`; }
      console.log(JSON.stringify({ started: true, terminal: name, address, in_app_layout: placed, ...(warn ? { warning: warn } : {}) }));
      break;
    }
    case "run": need(); host(statePath); break;
    case "say": L.drop(need().inbox, { type: "say", text: o._.slice(1).join(" ") }); break;
    case "sources":
      console.log(JSON.stringify(Object.fromEntries(Object.entries(L.SOURCES).map(([id, x]) => [id, Boolean(which(BIN[x.bin]))]))));
      break;
    case "invite": L.drop(need().inbox, { type: "invite", member: JSON.parse(o._[1]) }); break;
    case "set": {
      const msg = { type: "set" };
      for (const kv of o._.slice(1)) {
        const [k, v] = kv.split("=");
        if (k === "allow_yolo") msg.allow_yolo = v === "true";
        else if (k === "act") msg.act = v === "true";
        else if (k === "max_rounds") msg.max_rounds = Number(v);
        else if (k === "chair_agent") msg.chair_agent = L.source(v);
        else if (k === "chair_model") msg.chair_model = L.modelName(v) ?? "";
        else throw new Error(`不認得的設定:${k}`);
      }
      L.drop(need().inbox, msg);
      break;
    }
    case "card": L.drop(need().inbox, { type: "card", todos: String(o._[1] ?? "").split(",").filter(Boolean).map(Number) }); break;
    case "quit": L.drop(need().inbox, { type: "quit" }); break;
    default:
      console.error("用法:runner.mjs new|list|start|run|say|invite|set|card|quit|sources …(見檔頭)");
      process.exit(2);
  }
}

try { main(); } catch (e) { console.error(`k-chat: ${e.message}`); process.exit(1); }
