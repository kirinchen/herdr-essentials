// k-spaces (herdr-essentials): the sessions an agent already had in a folder, for the space row's
// "+" menu: pick one to go on with it, or start a new one. Read on the machine the agent ran on.
//   Claude Code: one .jsonl a session under ~/.claude/projects/<the folder, every other character a
//     dash>/, read by one sh (Windows: PowerShell). Goes on with `claude --resume <id>`.
//   Codex: ~/.codex/sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl, every folder's together; the
//     first line names the folder. `codex resume <id>`.
//   Gemini (Antigravity's agy): the table in ~/.gemini/antigravity-cli/conversation_summaries.db
//     (SQLite). `agy --conversation <id>`.
//   Codex and agy are read by one node script (NODE below; agy's needs a node with node:sqlite: 23.4+,
//   or 22.5+ started with its flag, which this doesn't pass). No node there, or anything else failing:
//   no list, and the menu starts a new session as before.
// Runs nobody had on screen (claude -p, codex exec, agy -p: k-chat's members, scripts) are left out.
// The parts that don't run anything are tested, and so are the scripts on a made-up home.

export const MAX = 12;

/** Is this one of knownAgents() Claude Code? (by its key, or its program's name) */
export function isClaude(agent) {
  return ["claude", "claude-code"].includes(String(agent?.key ?? "").toLowerCase()) || program(agent) === "claude";
}
const program = (agent) => String(agent?.run?.[0] ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();

/** Which of the three an entry of knownAgents() is, by its key or its program's name; null: none (no list). */
export function kindOf(agent) {
  const key = String(agent?.key ?? "").toLowerCase(), prog = program(agent);
  if (isClaude(agent)) return "claude";
  if (key === "codex" || prog === "codex") return "codex";
  if (key === "agy" || key === "antigravity" || prog === "agy") return "agy";
  return null;
}

/** The folder's name under ~/.claude/projects: /home/k/my.repo → -home-k-my-repo, C:\Users\x → C--Users-x. */
export const projectDir = (folder) => String(folder ?? "").replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-");

/** What the agent is started with to go on with that session. They go after the agent's own flags:
 *  Codex's is a subcommand, and what follows it is the subcommand's. */
export const resumeArgs = (id, kind = "claude") => (kind === "codex" ? ["resume", id] : kind === "agy" ? ["--conversation", id] : ["--resume", id]);

// Both read only a session file's last 400 KB: they run to tens of MB (PowerShell's Get-Content -Tail
// took minutes on one, 2026-11-26 on the laptop).
// Newest first: a marker line, then that session's last title record, last prompt record, and how it
// was started ("entrypoint":"cli", or "sdk-cli" for a headless run); any of them may be missing.
export const POSIX = `d="$HOME/.claude/projects/$1"; [ -d "$d" ] || exit 0; ls -t "$d"/*.jsonl 2>/dev/null | head -${MAX} | while IFS= read -r f; do m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); b=\${f##*/}; echo "<<S \${b%.jsonl} $m>>"; tail -c 400000 "$f" | grep -a '"type":"[a-z]*-title"' | tail -1 | cut -c1-800; tail -c 400000 "$f" | grep -a '"type":"last-prompt"' | tail -1 | cut -c1-1200; tail -c 400000 "$f" | grep -a -o '"entrypoint":"[^"]*"' | tail -1; done`;
export const PS = (dir) => `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $d=Join-Path $env:USERPROFILE '.claude\\projects\\${dir}'; if(Test-Path -LiteralPath $d){ Get-ChildItem -LiteralPath $d -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First ${MAX} | % { "<<S $($_.BaseName) $([DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeSeconds())>>"; $fs=[IO.File]::Open($_.FullName,'Open','Read','ReadWrite'); $n=[int][Math]::Min($fs.Length,400000); [void]$fs.Seek(-$n,'End'); $b=New-Object byte[] $n; $r=0; while($r -lt $n){ $k=$fs.Read($b,$r,$n-$r); if($k -le 0){ break }; $r+=$k }; $fs.Close(); $t=[Text.Encoding]::UTF8.GetString($b,0,$r) -split [char]10; ($t | Select-String -Pattern '"type":"[a-z]*-title"' | Select-Object -Last 1).Line; ($t | Select-String -SimpleMatch '"type":"last-prompt"' | Select-Object -Last 1).Line; $e=($t | Select-String -Pattern '"entrypoint":"[^"]*"' | Select-Object -Last 1); if($e){ $e.Matches[0].Value } } }`;

// Codex's and agy's sessions for a folder, newest first, as one line of JSON on stdout:
//   node -e NODE <codex|agy> <folder>
// Plain CommonJS, no backticks and no double quotes outside strings that need them less than this
// comment suggests: it travels as one argument, on Windows too.
// Codex: the newest files first (at most 400 looked at); the first line (session_meta) has the folder
//   (cwd), the id, and who started it (codex exec: left out); the prompt is what the person last said
//   (lastSaid: the laptop's real sessions, Codex Desktop's, have no user_message events).
// agy: rows with a title (a -p run never gets one) whose workspace is the folder.
export const NODE = String.raw`
const fs = require('fs'), path = require('path'), os = require('os');
const kind = process.argv[1], folder = process.argv[2], MAX = 12, out = [];
const norm = (p) => { let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s; };
const here = norm(folder);
const str = (text, key) => { const m = new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)').exec(text); if (!m) return ''; try { return JSON.parse('"' + m[1].replace(/\\$/, '') + '"'); } catch (e) { return m[1]; } };
const part = (file, tail, len) => { const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size, n = Math.min(len, size), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, tail ? size - n : 0); return b.toString('utf8'); } finally { fs.closeSync(fd); } };
// What the person last said in a Codex session: its user_message event, or (Codex Desktop writes none)
// the last user message among the response items that isn't something Codex put in itself (<environment_context>…,
// AGENTS.md and the like start with a tag or a heading).
const lastSaid = (text) => {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    let s = '';
    if (l.includes('"type":"user_message"')) s = str(l, 'message');
    else if (l.includes('"type":"response_item"') && l.includes('"role":"user"')) s = str(l, 'text');
    s = s.trim();
    if (s && !/^[<#]/.test(s)) return s;
  }
  return '';
};
if (kind === 'codex') {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const down = (dir) => { try { return fs.readdirSync(dir).sort().reverse(); } catch (e) { return []; } };
  let looked = 0;
  scan: for (const y of down(root)) for (const m of down(path.join(root, y))) for (const d of down(path.join(root, y, m))) for (const name of down(path.join(root, y, m, d))) {
    if (!name.endsWith('.jsonl')) continue;
    if (out.length >= MAX || ++looked > 400) break scan;
    const file = path.join(root, y, m, d, name);
    try {
      const head = part(file, false, 16000).split('\n')[0];
      if (norm(str(head, 'cwd')) !== here) continue;
      if (/"originator":"codex_exec"|"source":"exec"/.test(head)) continue;
      const id = (/"id":"([0-9a-fA-F-]{36})"/.exec(head) || /([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})\.jsonl$/.exec(name) || [])[1];
      if (!id) continue;
      out.push({ id: id, at: fs.statSync(file).mtimeMs, title: '', prompt: lastSaid(part(file, true, 300000)) || lastSaid(part(file, false, 300000)) });
    } catch (e) {}
  }
  out.sort((a, b) => b.at - a.at);
} else if (kind === 'agy') {
  const db = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  if (fs.existsSync(db)) {
    const d = new (require('node:sqlite').DatabaseSync)(db, { readOnly: true });
    const rows = d.prepare("select conversation_id id, title, preview, last_modified_time at, workspace_uris ws from conversation_summaries where title <> '' and parent_conversation_id = '' order by last_modified_time desc limit 300").all();
    for (const r of rows) {
      let ws = []; try { ws = JSON.parse(r.ws); } catch (e) {}
      const mine = ws.some((u) => { try { return norm(decodeURIComponent(String(u).replace(/^file:\/\//, ''))) === here; } catch (e) { return false; } });
      if (!mine) continue;
      const at = Date.parse(String(r.at).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
      out.push({ id: r.id, at: isFinite(at) ? at : 0, title: r.title, prompt: r.preview === r.title ? '' : r.preview });
      if (out.length >= MAX) break;
    }
    d.close();
  }
}
process.stdout.write(JSON.stringify(out));
`;

// A JSON string's value by its key, from a line that may have been cut short.
function field(line, key) {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)`).exec(line);
  if (!m) return "";
  try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch { return m[1]; }
}
const tidy = (s) => String(s ?? "").replace(/<[^>]{1,40}>/g, " ").replace(/\s+/g, " ").trim();

/** The script's output → [{ id, at (ms), title, prompt }], newest first. A session with neither a
 *  title nor a prompt (an empty one) is left out, and so is a headless run (`claude -p`: k-chat's
 *  members, scripts), which nobody had on screen. */
export function parse(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const head = /^<<S ([0-9A-Za-z-]{8,64}) (\d+)>>$/.exec(line.trim());
    if (head) { cur = { id: head[1], at: Number(head[2]) * 1000, title: "", prompt: "", headless: false }; out.push(cur); continue; }
    if (!cur) continue;
    const entry = /^"entrypoint":"([^"]*)"$/.exec(line.trim());
    if (entry) { cur.headless = entry[1].startsWith("sdk"); continue; }
    if (/"type":"[a-z]*-title"/.test(line)) cur.title = tidy(field(line, "aiTitle") || field(line, "customTitle") || field(line, "title"));
    else if (line.includes('"type":"last-prompt"')) cur.prompt = tidy(field(line, "lastPrompt"));
  }
  return out.filter((s) => !s.headless && (s.title || s.prompt)).map(({ headless, ...s }) => s);
}

/** NODE's output → the same rows as parse(): tidy text, an id that can be an argument, nothing
 *  without a title or a prompt. Anything else (node's own complaints, no output) → []. */
export function parseJson(stdout) {
  let rows = [];
  try { rows = JSON.parse(String(stdout ?? "").trim().split(/\r?\n/).pop() || "[]"); } catch { return []; }
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === "string" && /^[0-9A-Za-z-]{8,64}$/.test(r.id))
    .map((r) => ({ id: r.id, at: Number(r.at) || 0, title: tidy(r.title).slice(0, 200), prompt: tidy(r.prompt).slice(0, 600) }))
    .filter((s) => s.title || s.prompt);
}

/** "3m", "5h", "2d": how long ago. */
export function ago(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** An agent's sessions in `folder` on `machine` (null: this one). `kind`: "claude" (default), "codex", "agy".
 *  `exec`: herdr's; `posix`: that machine's shell (only Claude Code's list asks). */
export async function list(exec, { folder, machine = null, posix = true, kind = "claude" }) {
  if (!folder) return [];
  const on = { on: machine ?? null, timeout: 20000 };
  if (kind === "codex" || kind === "agy") return parseJson((await exec("node", ["-e", NODE, kind, folder], on)).stdout);
  const dir = projectDir(folder);
  if (!dir) return [];
  const r = posix ? await exec("sh", ["-c", POSIX, "k-sessions", dir], on) : await exec("powershell.exe", ["-NoProfile", "-Command", PS(dir)], on);
  return parse(r.stdout);
}
