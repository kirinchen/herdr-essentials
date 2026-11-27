// k-chat runner (tools/k-chat): whole discussions run offline, with stand-ins for claude, codex,
// agy, hc and tide's task (tests/fixtures). Checks the record, the state, and what each agent was
// started with (read-only vs YOLO, resume, the other machine going through hc).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as L from "../tools/k-chat/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "tools", "k-chat", "runner.mjs");
const FIX = (n) => path.join(HERE, "fixtures", n);

function setup(chair, opts = [], list = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "k-chat-"));
  const dirs = Object.fromEntries(["main", "alpha", "beta", "gamma", "fake"].map((n) => [n, path.join(root, n)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dirs.fake, "chair.json"), JSON.stringify(chair));
  const env = { ...process.env, K_CHAT_CLAUDE: FIX("fake-claude.mjs"), K_CHAT_CODEX: FIX("fake-codex.mjs"), K_CHAT_AGY: FIX("fake-agy.mjs"), K_CHAT_HC: FIX("fake-hc.mjs"), K_CHAT_TASK: FIX("fake-task.mjs"), K_FAKE_DIR: dirs.fake, K_CHAT_TICK: "40" };
  const members = list?.(dirs) ?? [{ space: "alpha", cwd: dirs.alpha }, { space: "beta", cwd: dirs.beta, machine: "laptop" }];
  const cli = (...args) => spawnSync("node", [RUNNER, ...args], { env, encoding: "utf8" });
  const made = cli("new", "--repo", dirs.main, "--topic", "方案 討論", "--members", JSON.stringify(members), "--say", "要用哪個方案?", ...opts);
  assert.equal(made.status, 0, made.stderr);
  const state = made.stdout.trim();
  const f = L.filesOf(state);
  const t = {
    root, dirs, env, state, f, cli,
    start() { t.proc = spawn("node", [RUNNER, "run", state], { env, stdio: "ignore" }); return t.proc; },
    s: () => JSON.parse(fs.readFileSync(state, "utf8")),
    md: () => fs.readFileSync(f.md, "utf8"),
    calls: () => { try { return fs.readFileSync(path.join(dirs.fake, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    flag: (name, on) => { const p = path.join(dirs.fake, name); if (on) fs.writeFileSync(p, ""); else fs.rmSync(p, { force: true }); },
    async until(what, ok, ms = 15000) {
      const end = Date.now() + ms;
      for (;;) {
        try { if (ok()) return; } catch {}
        if (Date.now() > end) throw new Error(`等不到:${what}\n--- record ---\n${t.md()}\n--- state ---\n${fs.readFileSync(state, "utf8")}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    },
    async stop() {
      if (t.proc && t.proc.exitCode === null) { t.proc.kill("SIGTERM"); await new Promise((r) => t.proc.once("exit", r)); }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return t;
}
const pick = (next, more = {}) => ({ next, ask: `請 ${next} 說明`, yolo: false, done: false, reason: "輪到他", ...more });

test("一般對話:不經主席,Owner 說一句、agent 答一句;可動手由 Owner 開關;邀第二個人就回到主席制", async () => {
  const t = setup([pick("beta")], ["--direct"], (d) => [{ space: "alpha", cwd: d.alpha }]);
  try {
    assert.equal(t.s().direct, true);
    assert.match(t.md(), /k-chat 一般對話 · [^\n]*對象:alpha@alpha/);
    t.start();
    await t.until("第一個回答", () => t.s().status === "waiting" && t.s().round === 1);
    assert.deepEqual(L.messages(t.md()).map((m) => m.role), ["owner", "member"]);
    let calls = t.calls();
    assert.equal(calls.length, 1, "沒有叫主席");
    assert.ok(calls[0].args.includes("--tools") && !calls[0].args.includes("--dangerously-skip-permissions"), "預設唯讀");
    assert.match(calls[0].input, /只有你和他/);

    t.cli("set", t.state, "act=true");
    t.cli("say", t.state, "那就改吧");
    await t.until("第二個回答", () => t.s().status === "waiting" && t.s().round === 2);
    calls = t.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes("--dangerously-skip-permissions") && calls[1].args.includes("--resume"), "可動手、接續同一個 session");
    assert.match(calls[1].input, /Owner 允許你動手/);
    assert.equal(t.md().split("🔓 Owner 允許 alpha 動手").length, 2);

    // 超過輪數上限也不會自己收尾
    t.cli("set", t.state, "max_rounds=1", "act=false");
    t.cli("say", t.state, "再問一題");
    await t.until("第三個回答", () => t.s().status === "waiting" && t.s().round === 3);
    assert.ok(!t.calls()[2].args.includes("--dangerously-skip-permissions"), "收回後又是唯讀");
    assert.ok(!t.md().includes("結論"));

    t.cli("invite", t.state, JSON.stringify({ space: "beta", cwd: t.dirs.beta }));
    t.cli("say", t.state, "beta 你覺得呢");
    await t.until("主席點 beta", () => t.s().round === 4);
    assert.equal(t.s().direct, false);
    assert.match(t.md(), /不再是一對一/);
    assert.ok(t.calls().some((c) => c.args.includes("--json-schema")), "現在有主席了");
  } finally { await t.stop(); }
  // 沒有開場的一般對話(Space 的「+」→ Chat):先等 Owner,不會叫 agent 回答空話
  const quiet = setup([], ["--direct"], (d) => [{ space: "alpha", cwd: d.alpha }]);
  try {
    const made = quiet.cli("new", "--direct", "--repo", quiet.dirs.main, "--topic", "空的", "--members", JSON.stringify([{ space: "alpha", cwd: quiet.dirs.alpha }]));
    assert.equal(made.status, 0, made.stderr);
    assert.equal(JSON.parse(fs.readFileSync(made.stdout.trim(), "utf8")).status, "waiting");
  } finally { await quiet.stop(); }
  assert.throws(() => L.newState({ repo: "/r", topic: "t", direct: true, list: [{ space: "a", cwd: "/a" }, { space: "b", cwd: "/b" }] }), /剛好一個/);
});

test("porthole 開的對話:列得出來、接手後同一個檔接著聊,porthole 後來寫的也讀得到", async () => {
  const t = setup([], ["--direct"], (d) => [{ space: "alpha", cwd: d.alpha }]);
  try {
    const chat = path.join(t.dirs.main, "doc", "chat");
    const md = path.join(chat, "oauth-redirect.md");
    fs.writeFileSync(md, "# OAuth redirect 的區網解法\n\n## 🧑 Human · 2026-11-27T01:00:00.000Z\n\nredirect URL 怎麼辦\n\n## 🤖 Assistant · 2026-11-27T01:01:00.000Z\n\n用 tailnet 的名字\n");
    fs.writeFileSync(path.join(chat, "note.md"), "# 筆記\n\n沒有 turn 的檔不列\n");
    const list = JSON.parse(t.cli("list", "--repo", t.dirs.main).stdout);
    const p = list.find((x) => x.porthole);
    assert.equal(list.filter((x) => x.porthole).length, 1, "只列有對話的檔");
    assert.deepEqual([p.md, p.title, p.round], [md, "OAuth redirect 的區網解法", 2]);

    const adopted = t.cli("adopt", md, "--space", "alpha", "--members", JSON.stringify([{ space: "alpha", cwd: t.dirs.alpha }]));
    assert.equal(adopted.status, 0, adopted.stderr);
    const state = adopted.stdout.trim();
    assert.equal(state, md.replace(/\.md$/, ".json"));
    assert.equal(t.cli("adopt", md, "--members", "[]").stdout.trim(), state, "再接手一次:同一個");
    assert.ok(!JSON.parse(t.cli("list", "--repo", t.dirs.main).stdout).some((x) => x.porthole), "接手後是 k-chat 的對話");
    const s = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.deepEqual([s.direct, s.status, s.title], [true, "waiting", "OAuth redirect 的區網解法"]);
    assert.ok(fs.readFileSync(md, "utf8").startsWith("# OAuth redirect 的區網解法\n\n## 🧑 Human"), "紀錄沒被動到");

    const proc = spawn("node", [RUNNER, "run", state], { env: t.env, stdio: "ignore" });
    const answered = async (n) => { for (let i = 0; i < 500 && JSON.parse(fs.readFileSync(state, "utf8")).round < n; i += 1) await new Promise((r) => setTimeout(r, 30)); };
    try {
      t.cli("say", state, "那 laptop 呢");
      await answered(2);
      assert.match(t.calls()[0].input, /redirect URL 怎麼辦[\s\S]*用 tailnet 的名字[\s\S]*那 laptop 呢/, "第一輪讀整個檔(含 porthole 的)");
      // porthole 又在同一個檔聊了一輪,回到 k-chat 再講話:那段也帶得到
      fs.appendFileSync(md, "\n## 🧑 Human · 2026-11-27T02:00:00.000Z\n\n在 porthole 問的\n\n## 🤖 Assistant · 2026-11-27T02:00:30.000Z\n\nporthole 的回答\n");
      t.cli("say", state, "回到 k-chat");
      await answered(3);
      assert.match(t.calls()[1].input, /在 porthole 問的[\s\S]*porthole 的回答[\s\S]*回到 k-chat/);
      assert.equal(L.messages(fs.readFileSync(md, "utf8")).length, 8);
    } finally { proc.kill("SIGTERM"); await new Promise((r) => proc.once("exit", r)); }
  } finally { await t.stop(); }
});

test("主席自己也說話:先講再點名;自己答得了就直接回 Owner", async () => {
  const t = setup([pick("alpha", { say: "先整理一下:兩個方案差在成本。\n\n## 我的看法\n\n偏向甲。" }), pick("owner", { say: "這題我直接答:用甲。", ask: "同意嗎?" })]);
  try {
    t.start();
    await t.until("等 Owner", () => t.s().status === "waiting");
    const msgs = L.messages(t.md());
    assert.deepEqual(msgs.map((m) => m.role), ["owner", "chair", "member", "chair"]);
    assert.match(msgs[1].text, /^先整理一下:兩個方案差在成本。[\s\S]*### 我的看法[\s\S]*→ \*\*@alpha\*\*:請 alpha 說明/, "主席的話在點名前面,自己的標題降級");
    assert.match(msgs[3].text, /^這題我直接答:用甲。\n\n→ \*\*@Owner\*\*:同意嗎?/);
    assert.equal(t.calls().filter((c) => !c.args.includes("--json-schema")).length, 1, "主席回 Owner 那一輪沒有叫成員");
    assert.equal(L.turnFrom(t.s(), { next: "alpha" }, null).say, "", "沒給 say 就是空的");
  } finally { await t.stop(); }
});

test("一場討論:主席輪流點名、YOLO 只開那一輪、別台機器走 hc、結論與開卡", async () => {
  const t = setup([pick("alpha"), pick("beta", { yolo: true, reason: "談定了,請 beta 實作" }), pick("alpha")]);
  try {
    t.start();
    await t.until("結論", () => t.s().status === "done");
    const msgs = L.messages(t.md());
    assert.deepEqual(msgs.map((m) => m.role), ["owner", "chair", "member", "chair", "member", "chair", "member", "chair"]);
    assert.deepEqual(msgs.filter((m) => m.role === "member").map((m) => m.who), ["alpha@alpha", "beta@beta", "alpha@alpha"]);
    assert.equal(msgs[0].text, "要用哪個方案?");
    assert.match(msgs.at(-1).text, /結論[\s\S]*用方案甲/);
    // 🔓 那一行只出現一次,在點 beta 的那則裡
    assert.equal(t.md().split("🔓 主席授權 beta YOLO:談定了,請 beta 實作").length, 2);
    assert.equal(t.md().split("🔓").length, 2);

    const turns = t.calls().filter((c) => !c.args.includes("--json-schema"));
    assert.equal(turns.length, 3);
    const [a1, b1, a2] = turns;
    assert.ok(a1.args.includes("--tools") && a1.args.includes("--strict-mcp-config") && !a1.args.includes("--dangerously-skip-permissions"));
    assert.equal(fs.realpathSync(a1.cwd), fs.realpathSync(t.dirs.alpha));
    assert.equal(a1.via, null);
    assert.ok(b1.args.includes("--dangerously-skip-permissions") && !b1.args.includes("--tools"), "YOLO 那一輪不限工具");
    assert.equal(b1.via, "hc:laptop", "別台機器的成員走 hc exec --on");
    assert.equal(fs.realpathSync(b1.cwd), fs.realpathSync(t.dirs.beta));
    assert.match(b1.input, /授權你這一輪動手/);
    assert.ok(!a2.args.includes("--dangerously-skip-permissions") && a2.args.includes("--tools"), "下一輪恢復唯讀");
    assert.deepEqual(a2.args.slice(a2.args.indexOf("--resume"), a2.args.indexOf("--resume") + 2), ["--resume", "sess-alpha"], "第二次發言接續自己的 session");
    assert.ok(!a1.args.includes("--resume"));
    assert.match(a1.input, /你被邀請進一場多 agent 討論/);
    assert.ok(!/你被邀請進/.test(a2.input) && /beta 的回答/.test(a2.input), "之後只給上次發言以後的紀錄");
    // 主席:不給工具、用設定的模型
    const chair = t.calls().find((c) => c.args.includes("--json-schema"));
    assert.equal(chair.args[chair.args.indexOf("--model") + 1], "sonnet");
    assert.equal(chair.args[chair.args.indexOf("--tools") + 1], "");

    const s = t.s();
    assert.equal(s.round, 3);
    assert.deepEqual(s.todos.map((x) => [x.title, x.repo, x.card]), [["寫文件", "alpha", null], ["加測試", "beta", null]]);
    assert.ok(!fs.existsSync(path.join(t.dirs.fake, "task.jsonl")), "結論不會自己開卡");

    // Owner 按了才開卡
    assert.equal(t.cli("card", t.state, "1").status, 0);
    await t.until("開卡", () => t.s().todos[1].card === 999);
    const task = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "task.jsonl"), "utf8").trim());
    assert.deepEqual(task.args.slice(0, 5), ["create", "--repo", "beta", "--title", "加測試"]);
    assert.equal(task.who, "main");
    assert.match(task.body, /補單元測試[\s\S]*「方案 討論」[\s\S]*doc\/chat\/chat-\d{8}-\d{6}\.md/);
    assert.equal(t.s().todos[0].card, null);
    assert.ok(t.md().includes("🗂 Owner 把待辦開成 Tide 卡:\n- #999 加測試(beta)"));

    // 結束後 Owner 再發言:重新開始,多給幾輪
    t.cli("say", t.state, "@beta 再補充一點");
    await t.until("重開後 beta 發言", () => t.s().round >= 4);
    assert.equal(L.messages(t.md()).filter((m) => m.role === "member").at(-1).who, "beta@beta");
    assert.ok(t.s().max_rounds >= 3 + 6);

    t.cli("quit", t.state);
    await new Promise((r) => t.proc.once("exit", r));
    assert.equal(t.s().runner, null);
  } finally { await t.stop(); }
});

test("Owner 插隊:/stop 中止這一輪,@某人 讓他下一個發言、不經主席", async () => {
  const t = setup([pick("alpha"), pick("alpha"), pick("alpha")]);
  try {
    t.flag("slow-alpha", true);            // alpha 的第一輪卡住,這時 Owner 發言
    t.start();
    await t.until("alpha 發言中", () => t.s().now?.phase === "member" && t.s().now.who === "alpha");
    t.cli("say", t.state, "/stop");
    await t.until("停下來", () => /⏹ Owner 中止了這一輪/.test(t.md()) && t.s().status === "waiting" && t.s().now.phase === "waiting");
    assert.ok(!/alpha 的回答/.test(t.md()), "被中止的那一輪沒有回答");
    assert.equal(t.s().round, 0);
    t.flag("slow-alpha", false);
    t.cli("say", t.state, "@beta 請說");
    await t.until("beta 回答", () => /beta 的回答/.test(t.md()));
    const msgs = L.messages(t.md());
    const i = msgs.findIndex((m) => m.text === "@beta 請說");
    assert.equal(msgs[i].role, "owner");
    assert.equal(msgs[i + 1].who, "beta@beta", "Owner 點名後直接是他,中間沒有主席");
    const b = t.calls().filter((c) => !c.args.includes("--json-schema")).find((c) => c.via === "hc:laptop");
    assert.match(b.input, /Owner 點名你回答/);
    assert.ok(b.args.includes("--tools"), "Owner 點名的那一輪是唯讀");
  } finally { await t.stop(); }
});

test("關掉主持程式再開:接著跑;同時開兩個會被擋", async () => {
  const t = setup([pick("alpha"), pick("beta"), pick("alpha"), pick("beta")]);
  try {
    t.flag("slow-beta", true);
    t.start();
    await t.until("beta 發言中", () => t.s().now?.who === "beta" && t.s().round === 1);
    const second = spawnSync("node", [RUNNER, "run", t.state], { env: t.env, encoding: "utf8" });
    assert.equal(second.status, 3);
    assert.match(second.stderr, /已經有主持程式在跑/);
    t.proc.kill("SIGTERM");
    await new Promise((r) => t.proc.once("exit", r));
    assert.equal(t.s().runner, null);
    assert.equal(t.s().status, "running");
    t.flag("slow-beta", false);
    t.start();
    await t.until("跑完", () => t.s().status === "done");
    assert.equal(t.s().members.find((m) => m.name === "alpha").session, "sess-alpha");
    assert.equal(t.md().split(/^# /m).length, 2, "標頭只寫一次");
    assert.ok(L.messages(t.md()).filter((m) => m.role === "member").length >= 3);
  } finally { await t.stop(); }
});

test("輪數上限、關掉 YOLO、中途邀請、失敗會記下來", async () => {
  const t = setup([pick("alpha", { yolo: true }), pick("beta"), pick("alpha"), pick("alpha")], ["--max-rounds", "2", "--no-yolo"]);
  try {
    t.start();
    await t.until("到上限收尾", () => t.s().status === "done");
    assert.equal(t.s().round, 2);
    assert.ok(!t.md().includes("🔓"), "關掉後主席開不了 YOLO");
    assert.ok(t.calls().every((c) => !c.args.includes("--dangerously-skip-permissions")));
    assert.ok(t.md().includes("### 結論\n\n> 到了 2 輪上限\n\n#### 決定"));

    const gamma = t.dirs.gamma;
    t.cli("invite", t.state, JSON.stringify({ space: "gamma", cwd: gamma }));
    t.flag("fail-gamma", true);
    t.cli("say", t.state, "@gamma 歡迎,你怎麼看?");
    await t.until("gamma 失敗被記下", () => /⚠️ gamma 這一輪失敗:壞掉了/.test(t.md()));
    assert.match(t.md(), /➕ gamma@gamma 加入討論/);
    assert.equal(t.s().members.length, 3);
  } finally { await t.stop(); }
});

test("start:在 herdr-core 開自己的 terminal(hc run --keep),並寫進 Herdr App 排版;list 列得出來", async () => {
  const t = setup([]);
  try {
    const env = { ...t.env, TMUX: "/tmp/x,1,0", CLAUDECODE: "1" };
    const r = spawnSync("node", [RUNNER, "start", t.state], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.started, out.address, out.in_app_layout], [true, "t99", true]);
    assert.match(out.terminal, /^kchat-[0-9a-f]{8}$/);
    const call = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "hc-run.jsonl"), "utf8").trim());
    // hc 的旗標都在 -- 前面,後面才是程式
    for (const f of ["--bg", "--keep", "--no-parent", "--name", "--cwd"]) assert.ok(call.flags.includes(f), f);
    assert.equal(call.flags[call.flags.indexOf("--cwd") + 1], t.dirs.main);
    assert.deepEqual(call.argv.slice(1), [RUNNER, "run", t.state].map((x, i) => (i === 0 ? fs.realpathSync(x) : x)));
    assert.deepEqual(call.env, { TMUX: null, CLAUDECODE: null }, "子程序不帶這個 session 的 TMUX / CLAUDECODE");
    const doc = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "doc.json"), "utf8"));
    assert.equal(doc.version, 8);
    assert.equal(doc.value.other, "kept", "排版文件其他欄位原樣留著");
    const [sp] = doc.value.spaces;
    assert.equal(sp.folder, t.dirs.main);
    // 側欄那一列是對話畫面(k-chat mod),不是主持程式的 log
    assert.deepEqual(sp.tabs[0].root.children[0].content, { mod: "k-chat", props: { state: t.state, space: sp.id } });
    assert.equal(sp.tabs[0].name, "💬 方案 討論");
    // 已經在排版裡就不重複加
    const again = JSON.parse(spawnSync("node", [RUNNER, "start", t.state], { env, encoding: "utf8" }).stdout);
    assert.equal(again.in_app_layout, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "doc.json"), "utf8")).value.spaces[0].tabs.length, 1);

    const list = JSON.parse(t.cli("list", "--repo", t.dirs.main).stdout);
    assert.deepEqual(list.map((x) => [x.title, x.status, x.round, x.members]), [["方案 討論", "running", 0, ["alpha", "beta"]]]);
    assert.equal(list[0].path, t.state);
  } finally { await t.stop(); }
});

test("三種模型來源:成員各用各的、主席可以換,唯讀參數與 session 都對", async () => {
  const t = setup([pick("alpha"), pick("beta"), pick("gamma", { yolo: true, reason: "請動手" }), pick("gamma"), pick("alpha")], ["--chair-agent", "codex"], (d) => [
    { space: "alpha", cwd: d.alpha, agent: "codex", model: "gpt-x" }, { space: "beta", cwd: d.beta }, { space: "gamma", cwd: d.gamma, agent: "agy", machine: "laptop" }]);
  try {
    assert.match(t.md(), /主席 Codex · 成員:alpha@alpha\(Codex gpt-x\)、beta@beta\(Claude\)、gamma@gamma\(Gemini\)/);
    t.start();
    await t.until("結論", () => t.s().status === "done");
    assert.match(t.md(), /Codex 寫的結論/);
    const of = (bin, ok = () => true) => t.calls().filter((c) => (c.bin ?? "claude") === bin && ok(c.args));
    const chair = of("codex", (a) => a.includes("--output-schema"));
    assert.ok(chair.length >= 6 && chair.every((c) => c.args.includes("--ephemeral") && c.args[c.args.indexOf("--sandbox") + 1] === "read-only"));
    assert.notEqual(fs.realpathSync(path.dirname(chair[0].cwd)), fs.realpathSync(t.root), "主席不在任何 repo 裡跑");
    const [a1, a2] = of("codex", (a) => !a.includes("--output-schema"));
    assert.deepEqual(a1.args, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-x", "-"]);
    assert.deepEqual(a2.args.slice(-3), ["resume", "th-alpha", "-"]);
    assert.equal(of("claude").length, 1);
    const [g1, g2] = of("agy");
    assert.ok(g1.args.includes("--dangerously-skip-permissions") && !g1.args.includes("--sandbox") && !g1.args.includes("--settings"));
    assert.ok(!g2.args.includes("--dangerously-skip-permissions") && g2.args.includes("--sandbox"));
    const denied = (a) => JSON.parse(a[a.indexOf("--settings") + 1]).permissions.deny;
    for (const a of [g2.args, L.chairArgv({ agent: "gemini" }, {}).args]) for (const x of ["write_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)"]) assert.ok(denied(a).includes(x), x);
    assert.ok(!denied(g2.args).includes("read_file(*)") && denied(L.chairArgv({ agent: "gemini" }, {}).args).includes("read_file(*)"), "成員能讀,主席不用");
    assert.deepEqual(g2.args.slice(-2), ["--conversation", "conv-gamma"]);
    assert.equal(g1.via, "hc:laptop");
    assert.match(g1.input, /你被邀請進一場多 agent 討論/);
    assert.deepEqual(L.messages(t.md()).filter((m) => m.role === "member").map((m) => m.text), ["alpha 的回答(Codex)", "beta 的回答 #" + t.calls().findIndex((c) => !c.bin), "gamma 的回答(Gemini)", "gamma 的回答(Gemini)", "alpha 的回答(Codex)"]);

    // 換主席:別的來源就用它自己的預設模型
    assert.notEqual(t.cli("set", t.state, "chair_agent=grok").status, 0);
    t.cli("set", t.state, "chair_agent=gemini");
    await t.until("換主席", () => t.s().chair.agent === "gemini");
    assert.match(t.md(), /🪑 主席改用 Gemini。/);
    t.cli("say", t.state, "/end");
    t.cli("say", t.state, "再一輪 @beta");
    t.cli("say", t.state, "/end");
    await t.until("Gemini 收尾", () => /Gemini 寫的結論/.test(t.md()));
  } finally { await t.stop(); }
});

test("Gemini 的唯讀輪:agy 太舊、真的寫了檔、沒登入,都會停下來並記下", async () => {
  const t = setup([], [], (d) => [{ space: "gamma", cwd: d.gamma, agent: "gemini" }]);
  try {
    const turn = async (want) => { t.cli("say", t.state, "@gamma 說說看"); await t.until(String(want), () => want.test(t.md())); };
    t.flag("agy-old", true);
    t.start();
    await turn(/gamma 這一輪失敗:那台的 agy 太舊\(沒有 --settings\)/);
    t.flag("agy-old", false); t.flag("agy-writes", true);
    await turn(/gamma 這一輪失敗:唯讀輪裡 agy 跑了 write_to_file/);
    t.flag("agy-writes", false); t.flag("agy-out", true);
    await turn(/gamma 這一輪失敗:Gemini\(agy\):authentication failed or timed out\(先在那台機器跑一次 agy 登入\)/);
    t.flag("agy-out", false);
    await turn(/gamma 的回答\(Gemini\)/); // 被拒絕的 run_command 不算
  } finally { await t.stop(); }
});

test("lib:Owner 的話、主席的回答、紀錄格式", () => {
  const names = ["alpha", "beta"];
  assert.deepEqual(L.parseSay("/stop", names), { text: "/stop", stop: true, end: false, mentions: [] });
  assert.equal(L.parseSay("/end 收一收", names).end, true);
  assert.equal(L.parseSay("/stopwatch 是什麼", names).stop, false);
  assert.deepEqual(L.parseSay("@beta、@alpha 還有 @nobody,@beta 再一次", names).mentions, ["beta", "alpha"]);
  assert.equal(L.slug(" a/b: c "), "a-b-c");
  assert.equal(L.slug("k-chat 要不要支援 Codex"), "k-chat-Codex", "檔名只留英數(porthole 開得了)");
  assert.equal(L.slug("方案 討論", new Date(2026, 10, 27, 9, 5, 7)), "chat-20261127-090507");
  assert.throws(() => L.slug("  "));
  assert.deepEqual(L.members([{ space: "x", cwd: "/a" }, { space: "x", cwd: "/b", machine: "laptop" }, { space: "x", cwd: "/c" }]).map((m) => m.name), ["x", "x-laptop", "x-2"]);
  const s = L.newState({ repo: "/r/main", topic: "t", list: [{ space: "alpha", cwd: "/a" }, { space: "beta", cwd: "/b" }] });
  assert.equal(L.turnFrom(s, { next: "@beta", ask: "q", yolo: true }, null).yolo, true);
  assert.equal(L.turnFrom({ ...s, allow_yolo: false }, { next: "beta", yolo: true }, null).yolo, false);
  assert.equal(L.turnFrom(s, { next: "不存在" }, "alpha").next, "beta", "點到不存在的人:換下一位");
  assert.equal(L.turnFrom(s, { next: "Owner" }, null).next, "owner");
  const md = L.header(s) + L.entry("owner", "嗨") + L.entry("chair", "→ **@alpha**:說說看") + L.entry(s.members[0], "好\n\n### 小標不是新訊息");
  // porthole 的 #chat 用同一個規則切訊息
  assert.equal([...md.matchAll(/^## (🧑 Human|🤖 Assistant)[^\n]*$/gm)].length, 3);
  assert.deepEqual(L.messages(md).map((m) => [m.role, m.who]), [["owner", "Owner"], ["chair", "主席"], ["member", "alpha@alpha"]]);
  // 時間跟 porthole 一樣寫 ISO(它的收件匣據此排序),畫面上是 HH:MM;舊紀錄的 HH:MM 照原樣
  assert.match(md, /^## 🧑 Human · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/m);
  assert.match(L.messages(md)[0].time, /^\d\d:\d\d$/);
  assert.equal(L.messages("## 🧑 Human · 09:30\n\nhi\n")[0].time, "09:30");
  assert.ok(md.startsWith("# t\n"), "H1 就是標題(porthole 拿來當對話名稱)");
  assert.equal(L.titleOf("# 標題\n\n## 🤖 Assistant · x\n\n# 內文的標題\n", "f"), "標題");
  assert.equal(L.titleOf("## 🧑 Human · x\n\n# 內文的標題\n", "f"), "f");
  assert.ok(L.memberArgv({ agent: "claude", fork: "abc" }, false).args.join(" ").includes("--resume abc --fork-session"));
  assert.deepEqual(L.memberArgv({ agent: "codex", session: "th1", model: "gpt-x" }, false).args, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-x", "resume", "th1", "-"]);
  assert.equal(L.source("agy"), "gemini");
  assert.equal(L.source(null), "claude");
  for (const bad of ["grok", "toString", "constructor"]) assert.throws(() => L.source(bad), /不認得的模型來源/);
  assert.equal(L.modelName(" opus "), "opus");
  assert.equal(L.modelName("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  for (const bad of ["--yolo", "a b", 'x"&calc', "a;b", "$(x)"]) assert.throws(() => L.modelName(bad), /模型名字不對/);
  assert.throws(() => L.members([{ space: "x", cwd: "/a", agent: "codex", fork: "abc" }]), /只支援 Claude/);
  assert.deepEqual(L.newState({ repo: "/r", topic: "t", chairAgent: "codex" }).chair, { agent: "codex", model: null, machine: null });
  assert.deepEqual(L.newState({ repo: "/r", topic: "t" }).chair, { agent: "claude", model: "sonnet", machine: null });
  assert.equal(L.chairArgv({ model: "sonnet" }, {}).bin, "claude", "舊的狀態檔沒有 agent 欄");
  assert.deepEqual(L.structured({ text: "好的\n```json\n{\"a\":1}\n```" }), { a: 1 });
  assert.throws(() => L.parseReply("codex", '{"type":"turn.failed","error":{"message":"額度用完"}}'), /額度用完/);
  assert.equal(L.parseReply("claude", 'banner\n{"result":"hi","session_id":"s1"}\n').session, "s1");
  assert.throws(() => L.parseReply("claude", '{"is_error":true,"result":"no"}'), /no/);
});

test("Hermes:參數、唯讀守門、輸出", () => {
  assert.equal(L.source("hermes-agent"), "hermes");
  const ro = L.memberArgv({ agent: "hermes", session: "local-1", model: "anthropic/claude-sonnet-4.6" }, false);
  assert.equal(ro.bin, "hermes");
  assert.deepEqual(ro.args.slice(0, 6), ["chat", "--query-file", "-", "--format", "stream-json", "--source"]);
  assert.ok(ro.args.join(" ").includes("-t web") && ro.args.join(" ").includes("--resume local-1") && ro.args.join(" ").includes("--model anthropic/claude-sonnet-4.6"));
  assert.ok(!ro.args.includes("--yolo") && ro.guard, "唯讀輪有守門");
  const yo = L.memberArgv({ agent: "hermes" }, true);
  assert.ok(yo.args.includes("--yolo") && !yo.args.includes("-t") && !yo.guard && !yo.args.includes("--resume"));
  const ch = L.chairArgv({ agent: "hermes" }, {});
  assert.ok(ch.args.join(" ").includes("-t todo --ignore-rules"));
  assert.equal(L.feed("hermes", "hi"), "hi", "提示照原樣進 stdin");
  const s = { title: "t", members: [{ name: "h", space: "h", cwd: "/h", agent: "hermes" }, { name: "c", space: "c", cwd: "/c" }], round: 0, max_rounds: 3, allow_yolo: true };
  const ask = { from: "chair", ask: "看一下", yolo: false };
  assert.match(L.memberPrompt(s, s.members[0], "", ask), /只有網路搜尋,讀不到/);
  assert.doesNotMatch(L.memberPrompt(s, s.members[0], "", { ...ask, yolo: true }), /只有網路搜尋/);
  assert.doesNotMatch(L.memberPrompt(s, s.members[1], "", ask), /只有網路搜尋/, "Claude 讀得到檔,不加這句");
  assert.match(L.memberPrompt({ ...s, direct: true }, s.members[0], "", { from: "owner", yolo: false }), /只有網路搜尋,讀不到/);
  const tool = (name) => JSON.stringify({ type: "tool_use", name, input: {} });
  for (const w of ["write_file", "patch", "terminal", "execute_code"]) assert.match(ro.guard(tool(w)), /唯讀輪裡 Hermes 要用/);
  for (const r of ["read_file", "search_files", "web_search", "web_extract", "todo_list"]) assert.equal(ro.guard(tool(r)), null, r);
  const ok = L.parseReply("hermes", '{"type": "system", "subtype": "init"}\n{"type": "text", "text": "po"}\n{"type": "result", "session_id": "local-abc", "exit_code": 0, "text": "pong"}\n');
  assert.deepEqual(ok, { text: "pong", session: "local-abc", structured: null });
  assert.throws(() => L.parseReply("hermes", '{"type": "result", "session_id": "", "exit_code": 1, "text": "", "error": "invalid_params"}'), /Hermes:invalid_params/);
  assert.throws(() => L.parseReply("hermes", "Session: x"), /讀不懂 Hermes 的輸出/);
});
test("主席在別台機器:狀態、換來源、Codex 不行", () => {
  const s = L.newState({ repo: "/r", topic: "t", list: [{ space: "a", cwd: "/a", machine: "pi", agent: "hermes" }], chairAgent: "hermes", chairMachine: "pi" });
  assert.deepEqual(s.chair, { agent: "hermes", model: null, machine: "pi" });
  assert.match(L.header(s), /主席 Hermes\(在 pi\)/);
  assert.equal(L.newState({ repo: "/r", topic: "t" }).chair.machine, null, "沒給就是這台");
  assert.throws(() => L.newState({ repo: "/r", topic: "t", chairAgent: "codex", chairMachine: "pi" }), /Codex 不能在別台機器\(pi\)當主席/);
  assert.throws(() => L.machineName("a b; rm"), /機器名稱不對/);
  assert.equal(L.machineName(" "), null);
  assert.deepEqual(L.chairOf("claude", "sonnet", "pi"), { agent: "claude", model: "sonnet", machine: "pi" });
  assert.equal(L.chairLabel({ agent: "claude", model: "sonnet" }), "Claude sonnet");
});