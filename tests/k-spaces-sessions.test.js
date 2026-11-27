// k-spaces' session list (mods/k-spaces/sessions.js): the folder's name under ~/.claude/projects,
// reading the script's output, and the script itself on a made-up home (POSIX only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectDir, parse, parseJson, ago, isClaude, kindOf, resumeArgs, POSIX, list } from "../vscode-layout/mods/k-spaces/sessions.js";

test("projectDir: every other character becomes a dash", () => {
  assert.equal(projectDir("/home/k/my.repo_x/"), "-home-k-my-repo-x");
  assert.equal(projectDir("C:\\Users\\DDT\\Desktop\\projects\\a b"), "C--Users-DDT-Desktop-projects-a-b");
  assert.equal(projectDir(null), "");
});

test("isClaude, resumeArgs, ago", () => {
  assert.ok(isClaude({ key: "claude", run: ["claude"] }));
  assert.ok(isClaude({ key: "x", run: ["C:\\bin\\claude.cmd"] }));
  assert.ok(!isClaude({ key: "codex", run: ["codex"] }));
  assert.deepEqual(resumeArgs("abc"), ["--resume", "abc"]);
  assert.deepEqual([0, 5 * 60000, 3 * 3600000, 2 * 86400000].map((d) => ago(1e12 - d, 1e12)), ["now", "5m", "3h", "2d"]);
});

test("parse: title and last prompt, cut-off lines, sessions with nothing to show are left out", () => {
  const out = parse([
    "<<S 11111111-aaaa 1700000000>>",
    '{"type":"ai-title","aiTitle":"修 \\"tab\\" 列","sessionId":"x"}',
    '{"type":"last-prompt","lastPrompt":"<pasted>好</pasted>,commit 並 pu',
    "<<S 22222222-bbbb 1690000000>>",
    "<<S 33333333-cccc 1680000000>>\r",
    '{"type":"last-prompt","lastPrompt":"只有這句","leafUuid":"y"}',
    "noise",
    "<<S 44444444-dddd 1670000000>>",
    '{"type":"last-prompt","lastPrompt":"無頭跑的(claude -p)"}',
    '"entrypoint":"sdk-cli"',
    "<<S 55555555-eeee 1660000000>>",
    '{"type":"ai-title","aiTitle":"畫面上開的"}',
    '"entrypoint":"cli"',
  ].join("\n"));
  assert.deepEqual(out, [
    { id: "11111111-aaaa", at: 1700000000000, title: '修 "tab" 列', prompt: "好 ,commit 並 pu" },
    { id: "33333333-cccc", at: 1680000000000, title: "", prompt: "只有這句" },
    { id: "55555555-eeee", at: 1660000000000, title: "畫面上開的", prompt: "" },
  ]);
  assert.deepEqual(parse(""), []);
});

test("the script: newest first, from the folder's own directory only", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "k-sess-"));
  try {
    const dir = path.join(home, ".claude", "projects", projectDir("/w/repo"));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "projects", "-w-other"));
    fs.writeFileSync(path.join(home, ".claude", "projects", "-w-other", "zzzzzzzz-1.jsonl"), '{"type":"ai-title","aiTitle":"別的資料夾"}\n');
    fs.writeFileSync(path.join(dir, "aaaaaaaa-1.jsonl"), '{"type":"ai-title","aiTitle":"舊的"}\n{"type":"user"}\n{"type":"ai-title","aiTitle":"舊的,改過名"}\n');
    fs.writeFileSync(path.join(dir, "bbbbbbbb-2.jsonl"), '{"type":"user","entrypoint":"cli","x":1}\n{"type":"last-prompt","lastPrompt":"新的那句"}\n');
    fs.writeFileSync(path.join(dir, "cccccccc-3.jsonl"), '{"type":"user","entrypoint":"sdk-cli"}\n{"type":"last-prompt","lastPrompt":"無頭"}\n');
    fs.utimesSync(path.join(dir, "aaaaaaaa-1.jsonl"), 1000, 1000);
    fs.utimesSync(path.join(dir, "bbbbbbbb-2.jsonl"), 2000, 2000);
    const exec = async (cmd, args) => { const r = spawnSync(cmd, args, { env: { ...process.env, HOME: home }, encoding: "utf8" }); return { code: r.status, stdout: r.stdout }; };
    assert.deepEqual(await list(exec, { folder: "/w/repo" }), [
      { id: "bbbbbbbb-2", at: 2000000, title: "", prompt: "新的那句" },
      { id: "aaaaaaaa-1", at: 1000000, title: "舊的,改過名", prompt: "" },
    ]);
    assert.deepEqual(await list(exec, { folder: "/w/none" }), []);
    assert.ok(POSIX.includes("head -12"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("kindOf and resumeArgs: Claude Code, Codex, agy; anything else has no list", () => {
  assert.equal(kindOf({ key: "claude", run: ["claude"] }), "claude");
  assert.equal(kindOf({ key: "codex", run: ["codex"] }), "codex");
  assert.equal(kindOf({ key: "x", run: ["C:\\npm\\codex.cmd"] }), "codex");
  assert.equal(kindOf({ key: "antigravity", run: ["agy"] }), "agy");
  assert.equal(kindOf({ key: "gemini", run: ["gemini"] }), null);
  assert.equal(kindOf({ key: "pi", run: ["pi"] }), null);
  assert.deepEqual(resumeArgs("i", "codex"), ["resume", "i"]);
  assert.deepEqual(resumeArgs("i", "agy"), ["--conversation", "i"]);
  assert.deepEqual(resumeArgs("i", "claude"), ["--resume", "i"]);
});

test("parseJson: only rows with a usable id and something to show", () => {
  assert.deepEqual(parseJson('warning\n[{"id":"abcdefgh-1","at":5,"title":" a  b ","prompt":""},{"id":"bad id; rm","at":1,"title":"x"},{"id":"abcdefgh-2","at":1,"title":"","prompt":""}]'),
    [{ id: "abcdefgh-1", at: 5, title: "a b", prompt: "" }]);
  assert.deepEqual(parseJson("node: bad option"), []);
  assert.deepEqual(parseJson(""), []);
});

const runIn = (home, extra = {}) => async (cmd, args) => {
  const r = spawnSync(cmd, args, { env: { ...process.env, HOME: home, USERPROFILE: home, ...extra }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("Codex: this folder's sessions from every day's folder, newest first; codex exec and other folders left out", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "k-sess-codex-"));
  try {
    const put = (day, name, cwd, more, lines, mtime) => {
      const dir = path.join(home, ".codex", "sessions", ...day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-${day.join("-")}T10-00-00-${name}.jsonl`);
      fs.writeFileSync(file, [JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: name, cwd, ...more } }), ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n");
      fs.utimesSync(file, mtime, mtime);
    };
    const said = (message) => ({ type: "event_msg", payload: { type: "user_message", message } });
    const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333", D = "44444444-4444-4444-8444-444444444444";
    put(["2026", "11", "24"], A, "/w/repo", { originator: "codex_cli_rs" }, [said("舊的第一句"), said("舊的最後一句")], 1000);
    put(["2026", "11", "26"], B, "/w/repo/", { originator: "codex_cli_rs" }, [said("新的 \"引號\"")], 3000);
    put(["2026", "11", "26"], C, "/w/other", {}, [said("別的資料夾")], 4000);
    put(["2026", "11", "25"], D, "/w/repo", { originator: "codex_exec" }, [said("無頭跑的")], 2000);
    assert.deepEqual(await list(runIn(home), { folder: "/w/repo", kind: "codex" }), [
      { id: B, at: 3000000, title: "", prompt: '新的 "引號"' },
      { id: A, at: 1000000, title: "", prompt: "舊的最後一句" },
    ]);
    // Codex Desktop: no user_message events, what was said is among the response items, after what Codex put in itself
    const item = (role, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    const E = "55555555-5555-4555-8555-555555555555";
    put(["2026", "11", "27"], E, "/w/desk", { originator: "Codex Desktop", source: "vscode" },
      [item("user", "# AGENTS.md instructions\n…"), item("user", "<environment_context>\n  <cwd>/w/desk</cwd>"), item("user", "幫我寫一個通用CLAUDE.md"), item("assistant", "好"), item("user", "<turn_aborted>")], 5000);
    assert.deepEqual(await list(runIn(home), { folder: "/w/desk", kind: "codex" }), [{ id: E, at: 5000000, title: "", prompt: "幫我寫一個通用CLAUDE.md" }]);
    assert.deepEqual(await list(runIn(home), { folder: "/w/none", kind: "codex" }), []);
    // CODEX_HOME moves the whole thing
    assert.deepEqual(await list(runIn(home, { CODEX_HOME: path.join(home, "elsewhere") }), { folder: "/w/repo", kind: "codex" }), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

let sqlite = null; try { sqlite = await import("node:sqlite"); } catch {}
test("agy: titled conversations of this workspace, newest first", { skip: !sqlite }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "k-sess-agy-"));
  try {
    const dir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    const d = new sqlite.DatabaseSync(path.join(dir, "conversation_summaries.db"));
    d.exec("create table conversation_summaries (conversation_id text primary key, title text, preview text, last_modified_time datetime, workspace_uris text, parent_conversation_id text not null default '')");
    const add = d.prepare("insert into conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id) values (?,?,?,?,?,?)");
    add.run("aaaaaaaa-1", "修 tab 列", "修 tab 列", "2026-11-24 13:15:09.532032418+00:00", '["file:///w/repo"]', "");
    add.run("bbbbbbbb-2", "加測試", "幫我加測試", "2026-11-25 01:00:00.5+00:00", '["file:///w/other","file:///w/repo"]', "");
    add.run("cccccccc-3", "", "無頭跑的(-p),沒有標題", "2026-11-26 01:00:00+00:00", '["file:///w/repo"]', "");
    add.run("dddddddd-4", "別的資料夾", "x", "2026-11-26 02:00:00+00:00", '["file:///w/repo2"]', "");
    add.run("eeeeeeee-5", "子對話", "x", "2026-11-26 03:00:00+00:00", '["file:///w/repo"]', "aaaaaaaa-1");
    add.run("ffffffff-6", "Windows 的", "y", "2026-11-26 04:00:00+00:00", '["file:///c%3A/Users/K/My%20Repo"]', "");
    d.close();
    assert.deepEqual(await list(runIn(home), { folder: "/w/repo", kind: "agy" }), [
      { id: "bbbbbbbb-2", at: Date.parse("2026-11-25T01:00:00.5Z"), title: "加測試", prompt: "幫我加測試" },
      { id: "aaaaaaaa-1", at: Date.parse("2026-11-24T13:15:09.532Z"), title: "修 tab 列", prompt: "" },
    ]);
    assert.deepEqual((await list(runIn(home), { folder: "C:\\Users\\K\\My Repo\\", kind: "agy" })).map((s) => s.id), ["ffffffff-6"]);
    // no database: nothing, not an error
    assert.deepEqual(await list(runIn(path.join(home, "empty")), { folder: "/w/repo", kind: "agy" }), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
