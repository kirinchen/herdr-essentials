// Tests for mods/k-cards/transcript.js (run: node --test tests/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chat, projectDir, resumeId, splitChunk, utf8Length, toolSummary, usageLine, fence, RESOLVE, READ, resolvePs, readPs, powershell, windowsPath } from "../mods/k-cards/transcript.js";

const sh = (script, args, env = {}) => {
  const r = spawnSync("sh", ["-c", script, "k-cards", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("projectDir matches Claude Code's folder names", () => {
  assert.equal(projectDir("/home/kirin/Desktop/project/kelp"), "-home-kirin-Desktop-project-kelp");
  assert.equal(projectDir("/home/kirin/.local/state/x_y"), "-home-kirin--local-state-x-y");
});

test("resumeId finds the session on the command line", () => {
  const id = "6ee72991-1234-4abc-8def-0123456789ab";
  assert.equal(resumeId(["claude", "--resume", id]), id);
  assert.equal(resumeId(["claude", "-r", id]), id);
  assert.equal(resumeId(["claude", `--resume=${id}`]), id);
  assert.equal(resumeId(["claude", "-r"]), null);
  assert.equal(resumeId(["claude", "--dangerously-skip-permissions", "/tide:work 290"]), null);
});

test("utf8Length counts bytes", () => {
  assert.equal(utf8Length("abc"), 3);
  assert.equal(utf8Length("中文"), 6);
  assert.equal(utf8Length("😀"), 4);
  assert.equal(utf8Length("é"), 2);
});

test("splitChunk keeps complete lines and counts their bytes", () => {
  assert.deepEqual(splitChunk('{"a":1}\n{"b":2}\n{"c"', false), { lines: ['{"a":1}', '{"b":2}'], used: 16 });
  // A chunk from the middle drops its cut first line, and counts it as read.
  assert.deepEqual(splitChunk('ut"}\n{"中":1}\n', true), { lines: ['{"中":1}'], used: 5 + 10 });
  assert.deepEqual(splitChunk("no newline yet", false), { lines: [], used: 0 });
  assert.deepEqual(splitChunk("cut", true), { lines: [], used: 0 });
});

const L = (o) => JSON.stringify(o);
const user = (uuid, content, extra = {}) => L({ type: "user", uuid, message: { role: "user", content }, ...extra });
const asst = (uuid, id, content, extra = {}) => L({ type: "assistant", uuid, message: { id, role: "assistant", model: "claude-opus-5-5", content, usage: { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 300 } }, ...extra });

test("Chat turns a transcript into user, AI and note cards", () => {
  const c = new Chat();
  c.push([
    L({ type: "permission-mode", permissionMode: "default" }),
    user("u1", "<command-message>tide:work</command-message>\n<command-name>/tide:work</command-name>\n<command-args>290</command-args>"),
    user("u1m", [{ type: "text", text: "# skill body" }], { isMeta: true }),
    asst("a1", "m1", [{ type: "thinking", thinking: "hmm" }]),
    asst("a2", "m1", [{ type: "text", text: "Reading the card." }]),
    asst("a3", "m1", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "task show 290", description: "Read" } }]),
    user("r1", [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }]),
    asst("a4", "m2", [{ type: "text", text: "**Done.**" }]),
    asst("a5", "m2", [{ type: "text", text: "Second paragraph." }]),
    user("u2", "thanks"),
    user("u3", "<task-notification>\n<task-id>x</task-id>\n<summary>Monitor fired</summary>\n</task-notification>"),
    user("u4", "<local-command-caveat>ignore</local-command-caveat>"),
    asst("s1", "m9", [{ type: "text", text: "sidechain" }], { isSidechain: true }),
    L({ type: "cost-state", totalCostUSD: 1.25 }),
    L({ type: "ai-title", aiTitle: "k-cards work" }),
  ]);
  // One card per turn: the text, the tool call and the text after it are one reply.
  assert.deepEqual(c.cards.map((k) => k.kind), ["user", "ai", "user", "note"]);
  assert.equal(c.cards[0].text, "/tide:work 290");
  const [, first] = c.cards;
  assert.equal(first.parts.length, 3);
  assert.deepEqual(first.parts[0], { kind: "text", text: "Reading the card.", msg: "m1" });
  assert.equal(first.parts[1].kind, "tool");
  assert.equal(first.parts[1].summary, "task show 290");
  assert.equal(first.parts[1].result, "ok");
  assert.equal(first.parts[2].text, "**Done.**\n\nSecond paragraph.");
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(usageLine(first.usage), "context 2.0k · out 300");
  assert.equal(c.cards[3].text, "Task notification: Monitor fired");
  assert.equal(c.cost.usd, 1.25);
  assert.equal(c.title, "k-cards work");
});

test("Chat keeps each card's time", () => {
  const c = new Chat();
  c.push([user("u", "hi", { timestamp: "2026-11-22T00:12:03.000Z" }), asst("a", "m", [{ type: "text", text: "yo" }], { timestamp: "2026-11-22T00:12:40.000Z" })]);
  assert.deepEqual(c.cards.map((k) => k.at), ["2026-11-22T00:12:03.000Z", "2026-11-22T00:12:40.000Z"]);
});

test("Chat takes a turn split across two pushes", () => {
  const c = new Chat();
  c.push([user("u1", "go"), asst("a1", "m1", [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/x" } }])]);
  assert.equal(c.cards[1].parts[0].result, null);
  c.push([user("r", [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "body" }], is_error: true }]), asst("a2", "m2", [{ type: "text", text: "hi" }])]);
  assert.equal(c.cards.length, 2);
  assert.equal(c.cards[1].parts[0].result, "body");
  assert.equal(c.cards[1].parts[0].error, true);
  assert.equal(c.cards[1].parts[1].text, "hi");
});

test("Chat starts another card only after a message of yours", () => {
  const c = new Chat();
  c.push([
    user("u1", "go"),
    asst("a1", "m1", [{ type: "text", text: "one" }]),
    asst("a2", "m2", [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/x" } }]),
    user("r", [{ type: "tool_result", tool_use_id: "t", content: "body" }]),
    asst("a3", "m3", [{ type: "text", text: "two" }]),
    asst("a4", "m4", [{ type: "text", text: "three" }]),
    user("u2", "more"),
    asst("a5", "m5", [{ type: "text", text: "four" }]),
  ]);
  assert.deepEqual(c.cards.map((k) => k.kind), ["user", "ai", "user", "ai"]);
  assert.deepEqual(c.cards[1].parts.map((p) => p.text ?? p.name), ["one", "Read", "two", "three"]);
  assert.deepEqual(c.cards[3].parts.map((p) => p.text), ["four"]);
});

test("Chat unwraps a pasted message", () => {
  const c = new Chat();
  c.push([user("u", '\n\n<pasted_content id="b992">\nline one\nline two\n</pasted_content id="b992">\n')]);
  assert.equal(c.cards[0].text, "line one\nline two");
});

test("fence outlasts the backticks inside", () => {
  assert.equal(fence("a"), "```\na\n```");
  assert.equal(fence("x ```` y"), "`````\nx ```` y\n`````");
});

test("toolSummary picks the telling field", () => {
  assert.equal(toolSummary("Grep", { pattern: "foo\\s+bar", path: "src" }), "src");
  assert.equal(toolSummary("Bash", { command: "git\n status" }), "git status");
  assert.equal(toolSummary("X", { a: 1 }), '{"a":1}');
});

// Git Bash's sh prints /tmp/… where Node has C:\\…\\Temp\\…: on Windows the PowerShell tests below run.
const onWindows = process.platform === "win32";
test("RESOLVE finds the transcript through ~/.claude/sessions/<pid>.json", { skip: onWindows && "Windows reads with PowerShell" }, () => {
  const home = mkdtempSync(join(tmpdir(), "k-cards-"));
  const cwd = "/work/my_repo";
  const dir = join(home, ".claude", "projects", projectDir(cwd));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const sid = "aaaaaaaa-1111-4222-8333-444444444444";
  writeFileSync(join(dir, `${sid}.jsonl`), "");
  writeFileSync(join(dir, "bbbbbbbb-1111-4222-8333-444444444444.jsonl"), "");
  writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: sid, cwd }));
  const env = { HOME: home };
  assert.equal(sh(RESOLVE, ["4242", "", "/elsewhere"], env), `${sid}\n${join(dir, sid + ".jsonl")}\n`);
  // No record for the pid: the id on the command line, else the newest transcript of the folder.
  assert.equal(sh(RESOLVE, ["1", sid, cwd], env), `${sid}\n${join(dir, sid + ".jsonl")}\n`);
  utimesSync(join(dir, `${sid}.jsonl`), new Date(1000), new Date(1000));
  assert.equal(sh(RESOLVE, ["1", "", cwd], env), `\n${join(dir, "bbbbbbbb-1111-4222-8333-444444444444.jsonl")}\n`);
  // A known session without a file yet: wait for it, don't show another one.
  writeFileSync(join(home, ".claude", "sessions", "77.json"), JSON.stringify({ pid: 77, sessionId: "cccccccc-1111-4222-8333-444444444444", cwd }));
  assert.equal(sh(RESOLVE, ["77", "", cwd], env), "cccccccc-1111-4222-8333-444444444444\n\n");
});

test("READ reads the tail, then only what was added", { skip: onWindows && "Windows reads with PowerShell" }, () => {
  const f = join(mkdtempSync(join(tmpdir(), "k-cards-")), "t.jsonl");
  writeFileSync(f, "0123456789\n");
  assert.equal(sh(READ, [f, "-4", "100"]), "11 7\n789\n");
  assert.equal(sh(READ, [f, "-100", "100"]), "11 0\n0123456789\n");
  appendFileSync(f, "abc\n");
  assert.equal(sh(READ, [f, "11", "100"]), "15 11\nabc\n");
  assert.equal(sh(READ, [f, "15", "100"]), "15 15\n");
  assert.equal(sh(READ, [f, "11", "2"]), "15 11\nab");
  // Shorter than the offset: rewritten, start over.
  writeFileSync(f, "x\n");
  assert.equal(sh(READ, [f, "15", "100"]), "2 0\nx\n");
  assert.equal(sh(READ, [f + ".none", "0", "100"]), "missing\n");
});

test("RESOLVE takes a Windows cwd out of its JSON escapes", { skip: onWindows && "Windows reads with PowerShell" }, () => {
  const home = mkdtempSync(join(tmpdir(), "k-cards-"));
  const cwd = "C:\\Users\\DDT\\Desktop\\projects\\herdr-essentials";
  const dir = join(home, ".claude", "projects", "C--Users-DDT-Desktop-projects-herdr-essentials");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(dir, "dddddddd-1111-4222-8333-444444444444.jsonl"), "");
  // No session id yet: only the folder's newest transcript, so only the right folder name finds it.
  writeFileSync(join(home, ".claude", "sessions", "9.json"), JSON.stringify({ pid: 9, cwd }));
  assert.equal(sh(RESOLVE, ["9", "", ""], { HOME: home }).split("\n")[1], join(dir, "dddddddd-1111-4222-8333-444444444444.jsonl"));
  assert.equal(projectDir(cwd), "C--Users-DDT-Desktop-projects-herdr-essentials");
});

test("powershell() encodes the script as UTF-16LE base64", () => {
  const script = "Write-Output '中文 ok'\n";
  assert.deepEqual(powershell(script), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  assert.equal(powershell("ab").at(-1), Buffer.from("ab", "utf16le").toString("base64"));
  assert.equal(powershell("abc").at(-1), Buffer.from("abc", "utf16le").toString("base64"));
});

test("windowsPath tells a Windows terminal by its folder", () => {
  assert.equal(windowsPath("C:\\Users\\DDT"), true);
  assert.equal(windowsPath("d:/work"), true);
  assert.equal(windowsPath("/home/kirin"), false);
  assert.equal(windowsPath(""), false);
});

// On Windows: the PowerShell reads, the same cases as the sh ones.
const ps = (script, env = {}) => {
  const r = spawnSync("powershell.exe", powershell(script), { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("resolvePs finds the transcript (Windows)", { skip: !onWindows && "needs powershell.exe" }, () => {
  const home = mkdtempSync(join(tmpdir(), "k-cards-"));
  const cwd = "C:\\work\\my_repo";
  const dir = join(home, ".claude", "projects", projectDir(cwd));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const sid = "aaaaaaaa-1111-4222-8333-444444444444";
  writeFileSync(join(dir, `${sid}.jsonl`), "");
  writeFileSync(join(dir, "bbbbbbbb-1111-4222-8333-444444444444.jsonl"), "");
  writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: sid, cwd }));
  // $HOME in PowerShell is USERPROFILE.
  const env = { USERPROFILE: home, HOME: home };
  assert.equal(ps(resolvePs("4242", "", "C:\\elsewhere"), env), `${sid}\n${join(dir, sid + ".jsonl")}\n`);
  assert.equal(ps(resolvePs("1", sid, cwd), env), `${sid}\n${join(dir, sid + ".jsonl")}\n`);
  utimesSync(join(dir, `${sid}.jsonl`), new Date(1000), new Date(1000));
  assert.equal(ps(resolvePs("1", "", cwd), env), `\n${join(dir, "bbbbbbbb-1111-4222-8333-444444444444.jsonl")}\n`);
  writeFileSync(join(home, ".claude", "sessions", "77.json"), JSON.stringify({ pid: 77, sessionId: "cccccccc-1111-4222-8333-444444444444", cwd }));
  assert.equal(ps(resolvePs("77", "", cwd), env), "cccccccc-1111-4222-8333-444444444444\n\n");
});

test("readPs reads the tail, then only what was added (Windows)", { skip: !onWindows && "needs powershell.exe" }, () => {
  const f = join(mkdtempSync(join(tmpdir(), "k-cards-")), "t.jsonl");
  writeFileSync(f, "0123456789\n");
  assert.equal(ps(readPs(f, -4, 100)), "11 7\n789\n");
  assert.equal(ps(readPs(f, -100, 100)), "11 0\n0123456789\n");
  appendFileSync(f, "中\n");
  assert.equal(ps(readPs(f, 11, 100)), "15 11\n中\n");
  assert.equal(ps(readPs(f, 15, 100)), "15 15\n");
  writeFileSync(f, "x\n");
  assert.equal(ps(readPs(f, 15, 100)), "2 0\nx\n");
  assert.equal(ps(readPs(f + ".none", 0, 100)), "missing\n");
});

import { withCards, canSwitch, showingCards, showCards, SPLIT, CARDS, BOTTOM } from "../mods/k-tabs/chat.js";

const kmain = () => ({
  id: "root", type: "row", children: [
    { id: "sidebar", type: "column", children: [] },
    { id: "work", type: "column", children: [
      { id: "work-body", type: "row", children: [
        { id: "main", type: "block", size: { weight: 1 }, content: { tab: "active", pane: { radius: 10, gap: 8, border: { width: 1, color: "border" } } } },
        { id: "panel", type: "column", hidden: true, children: [] },
      ] },
    ] },
    { id: "bc27", type: "block", content: { mod: "k-cards" }, size: { px: 480 } },
  ],
});
const body = (root) => root.children[1].children[0];

test("withCards puts k-cards over the tab block, the terminal a strip under it", () => {
  const next = withCards(kmain(), true);
  const col = body(next).children[0];
  assert.equal(col.id, SPLIT);
  assert.equal(col.type, "column");
  assert.deepEqual(col.size, { weight: 1 });
  assert.equal(col.gap, 8);
  assert.equal(col.children[0].id, CARDS);
  assert.deepEqual(col.children[0].content, { mod: "k-cards" });
  assert.equal(col.children[0].hidden, undefined);
  assert.equal(col.children[1].id, "main");
  assert.deepEqual(col.children[1].size, { px: BOTTOM });
  assert.equal(next.children.length, 2, "the docked k-cards block is gone");
  assert.equal(withCards({ id: "root", type: "row", children: [] }, true), null);
});

test("Terminal hides the cards and gives the terminal the height; Cards brings them back", () => {
  const off = withCards(withCards(kmain(), true), false);
  const col = body(off).children[0];
  assert.equal(col.children[0].hidden, true);
  assert.deepEqual(col.children[1].size, { weight: 1 });
  assert.equal(col.children[1].min, undefined);
  assert.equal(showingCards(off), false);
  const on = withCards(off, true);
  assert.equal(body(on).children[0].children[0].hidden, undefined);
  assert.deepEqual(body(on).children[0].children[1].size, { px: BOTTOM });
  assert.equal(showingCards(on), true);
  assert.equal(body(on).children[0].children.length, 2);
});

test("the earlier stack becomes the column", () => {
  const root = kmain();
  const tab = body(root).children[0];
  body(root).children[0] = { id: "k-cards-stack", type: "stack", active: CARDS, size: { weight: 1 }, children: [{ ...tab, size: undefined }, { id: CARDS, type: "block", content: { mod: "k-cards" } }] };
  delete body(root).children[0].children[0].size;
  assert.equal(showingCards(root), true);
  const next = withCards(root, true);
  const col = body(next).children[0];
  assert.equal(col.id, SPLIT);
  assert.deepEqual(col.size, { weight: 1 });
  assert.deepEqual(col.children.map((c) => c.id), [CARDS, "main"]);
});

test("Cards | Terminal: layout.set each way, Herdr's own layouts left alone", () => {
  const calls = [];
  const run = (name, args) => calls.push([name, args]);
  assert.equal(canSwitch("main", kmain()), false, "Herdr's own layouts can't change structure");
  assert.equal(canSwitch("k-main", kmain()), true);
  showCards(run, kmain(), true);
  assert.equal(calls[0][0], "layout.set");
  assert.deepEqual(calls[1], ["k-cards.focus", undefined]);
  const set = calls[0][1].layout;
  assert.equal(showingCards(set), true);
  calls.length = 0;
  showCards(run, set, false);
  assert.equal(calls.length, 1);
  assert.equal(showingCards(calls[0][1].layout), false);
});
