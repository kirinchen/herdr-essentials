// k-spaces (herdr-essentials): what the agents on a machine have, read from their own files.
//   Agents dialog (a machine header's right-click → Agents): each installed agent's status (running
//     now, sessions today), its MCP servers (user scope, and machine scope = the admin-managed file),
//     its skills and plugins.
//   MCP & Skills dialog (a space's right-click): what the space's folder adds for each agent
//     (project scope): .mcp.json, .claude/skills, .codex/config.toml, .agents/skills, ...
// Everything comes from one exec on that machine (sh, or PowerShell on Windows) that prints the
// files and folders asked for; parsing happens here. Nothing is written.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, knownAgents, panes, spaces, theme, closeOverlay, props, window } from "herdr";

// ---- reading files on a machine ----------------------------------------------------------------

const systems = new Map(); // machine → Promise<{ posix, mac }>
export function system(machine) {
  const k = machine ?? "";
  if (!systems.has(k)) systems.set(k, (async () => {
    if (!machine) { const p = window()?.platform; return { posix: p !== "windows", mac: p === "macos" }; }
    try {
      const r = await exec("sh", ["-c", "uname"], { on: machine, timeout: 15000 });
      if (r.code === 0) return { posix: true, mac: /darwin/i.test(r.stdout ?? "") };
    } catch {}
    return { posix: false, mac: false };
  })());
  return systems.get(k);
}

const POSIX = String.raw`for a; do op=${"${a%%:*}"}; p=${"${a#*:}"}; case $p in "~"|"~/"*) p="$HOME${"${p#\\~}"}";; esac; case $op in F) if [ -f "$p" ]; then echo "<<K:BEGIN $a>>"; head -c 3000000 "$p"; echo; echo "<<K:END>>"; fi;; L) if [ -d "$p" ]; then echo "<<K:BEGIN $a>>"; for e in "$p"/* "$p"/.[!.]*; do [ -e "$e" ] || continue; n=${"${e##*/}"}; [ -d "$e" ] && n="$n/"; echo "$n"; done; echo "<<K:END>>"; fi;; S) if [ -d "$p" ]; then echo "<<K:BEGIN $a>>"; for d in "$p"/*/; do [ -d "$d" ] || continue; n=${"${d%/}"}; n=${"${n##*/}"}; echo "<<K:SK $n>>"; for f in "$d"SKILL.md "$d"skill.md; do if [ -f "$f" ]; then head -n 24 "$f"; break; fi; done; done; echo "<<K:END>>"; fi;; T) if [ -d "$p" ]; then echo "<<K:BEGIN $a>>"; find -L "$p" -maxdepth 2 -type f -newermt "$(date +%Y-%m-%d)" 2>/dev/null | wc -l; echo "<<K:END>>"; fi;; esac; done`;

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PS = (list) => `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $H=$env:USERPROFILE; $today=(Get-Date).Date; foreach($a in @(${list.map(psQuote).join(",")})){ $op=$a.Substring(0,1); $p=$a.Substring(2); if($p -eq '~' -or $p.StartsWith('~/')){ $p=$H+$p.Substring(1) }; $p=$p.Replace('/','\\'); switch($op){  'F' { if(Test-Path -LiteralPath $p -PathType Leaf){ "<<K:BEGIN $a>>"; [IO.File]::ReadAllText($p); "<<K:END>>" } } 'L' { if(Test-Path -LiteralPath $p -PathType Container){ "<<K:BEGIN $a>>"; Get-ChildItem -LiteralPath $p -Force | % { if($_.PSIsContainer){ $_.Name+'/' } else { $_.Name } }; "<<K:END>>" } } 'S' { if(Test-Path -LiteralPath $p -PathType Container){ "<<K:BEGIN $a>>"; Get-ChildItem -LiteralPath $p -Directory | % { "<<K:SK $($_.Name)>>"; $f=Join-Path $_.FullName 'SKILL.md'; if(Test-Path -LiteralPath $f){ Get-Content -LiteralPath $f -TotalCount 24 -Encoding UTF8 } }; "<<K:END>>" } } 'T' { if(Test-Path -LiteralPath $p -PathType Container){ "<<K:BEGIN $a>>"; @(Get-ChildItem -LiteralPath $p -File -Recurse -Depth 1 | ? { $_.LastWriteTime -ge $today }).Count; "<<K:END>>" } } }}`;

// ops: ["F:~/.claude.json", "L:dir", "S:skills dir", "T:dir"] → { "F:~/.claude.json": text, ... } (missing: absent).
async function gather(machine, ops) {
  if (!ops.length) return {};
  const sys = await system(machine);
  const on = { on: machine ?? null, timeout: 30000 };
  const r = sys.posix
    ? await exec("sh", ["-c", POSIX, "k-inspect", ...ops], on)
    : await exec("powershell.exe", ["-NoProfile", "-Command", PS(ops)], on);
  const out = {};
  let key = null, buf = [];
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    const b = /^<<K:BEGIN (.+)>>$/.exec(line);
    if (b) { key = b[1]; buf = []; continue; }
    if (line === "<<K:END>>" && key) { out[key] = buf.join("\n"); key = null; continue; }
    if (key) buf.push(line);
  }
  return out;
}

// ---- parsing ---------------------------------------------------------------------------------------

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

// { name: { command, args, url, type, disabled } } → [{ name, what, off }]
function servers(obj, off = []) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([name, s]) => ({
    name,
    what: s?.url ?? s?.httpUrl ?? s?.serverUrl ?? [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter(Boolean).join(" "),
    off: Boolean(s?.disabled) || off.includes(name),
  }));
}

// codex config.toml: [mcp_servers.<name>] command / url / enabled; [plugins."<name>"] enabled.
function toml(text) {
  const mcp = [], plugins = [];
  let cur = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[(.+)\]$/.exec(line);
    if (h) {
      const m = /^mcp_servers\.(?:"([^"]+)"|([^.\]]+))$/.exec(h[1]);
      const p = /^plugins\.(?:"([^"]+)"|([^.\]]+))$/.exec(h[1]);
      cur = m ? { kind: "mcp", item: { name: m[1] ?? m[2], what: "", off: false } }
        : p ? { kind: "plugin", item: { name: p[1] ?? p[2], version: "", off: false, skills: [] } } : null;
      if (cur) (cur.kind === "mcp" ? mcp : plugins).push(cur.item);
      continue;
    }
    if (!cur) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].replace(/^["']|["']$/g, "");
    if (cur.kind === "mcp" && (kv[1] === "command" || kv[1] === "url")) cur.item.what = v;
    if (cur.kind === "mcp" && kv[1] === "args" && cur.item.what) cur.item.what += " " + (json(kv[2]) ?? []).join(" ");
    if (kv[1] === "enabled" && v === "false") cur.item.off = true;
  }
  return { mcp, plugins };
}

// "S:" output → [{ name, about }]
function skills(text) {
  if (text == null) return [];
  const list = [];
  for (const part of String(text).split(/^<<K:SK /m).slice(1)) {
    const [head, ...rest] = part.split("\n");
    const name = head.replace(/>>$/, "");
    const body = rest.join("\n");
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
    const about = /^description:\s*(.+)$/m.exec(fm)?.[1]?.replace(/^["'>|]\s*|["']$/g, "").replace(/\*\*|`/g, "") ?? "";
    list.push({ name: /^name:\s*(.+)$/m.exec(fm)?.[1]?.replace(/^["']|["']$/g, "") || name, about });
  }
  return list;
}
const files = (text, re) => (text == null ? [] : String(text).split("\n").filter((n) => n && re.test(n)));
const count = (text) => (text == null ? null : Number.parseInt(String(text).trim(), 10) || 0);

// ---- what each agent keeps where -----------------------------------------------------------------

const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`; };
const managed = (sys) => (sys.posix ? (sys.mac ? "/Library/Application Support/ClaudeCode/managed-mcp.json" : "/etc/claude-code/managed-mcp.json") : "C:/ProgramData/ClaudeCode/managed-mcp.json");
const family = (a) => {
  const k = String(a?.key ?? "").toLowerCase();
  const prog = String(a?.run?.[0] ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  for (const f of ["claude", "codex", "gemini", "agy", "antigravity"]) if (k === f || prog === f) return f === "antigravity" ? "agy" : f;
  return null;
};

// One agent's user / machine scope: → { sections: [{ title, scope?, rows: [{ name, what, off }] }], today }
const USER = {
  claude: (sys) => ({
    ops: ["F:~/.claude.json", `F:${managed(sys)}`, "S:~/.claude/skills", "F:~/.claude/plugins/installed_plugins.json", "F:~/.claude/settings.json", "T:~/.claude/projects"],
    async read(g, machine) {
      const enabled = json(g["F:~/.claude/settings.json"])?.enabledPlugins ?? {};
      const installed = json(g["F:~/.claude/plugins/installed_plugins.json"])?.plugins ?? {};
      const plugins = Object.entries(installed).map(([name, v]) => {
        const it = Array.isArray(v) ? v[0] : v;
        return { name, version: it?.version ?? "", path: it?.installPath ?? "", off: enabled[name] === false || !(name in enabled), skills: [] };
      });
      // A plugin's skills: a second read of each one's skills folder.
      const more = await gather(machine, plugins.filter((p) => p.path && !p.off).map((p) => `S:${p.path}/skills`));
      for (const p of plugins) p.skills = skills(more[`S:${p.path}/skills`]).map((s) => s.name);
      return {
        today: count(g["T:~/.claude/projects"]),
        sections: [
          { title: "MCP servers", scope: "user", rows: servers(json(g["F:~/.claude.json"])?.mcpServers) },
          { title: "MCP servers", scope: "machine", rows: servers(json(g[`F:${managed(sys)}`])?.mcpServers), note: managed(sys) },
          { title: "Skills", scope: "user", rows: skills(g["S:~/.claude/skills"]).map((s) => ({ name: s.name, what: s.about })) },
          { title: "Plugins", scope: "user", rows: plugins.sort((a, b) => a.off - b.off).map((p) => ({ name: p.name, what: [p.version && `v${p.version}`, p.skills.length ? `skills: ${p.skills.join(", ")}` : ""].filter(Boolean).join(" · "), off: p.off })) },
        ],
      };
    },
  }),
  codex: () => ({
    ops: ["F:~/.codex/config.toml", "S:~/.codex/skills", `T:~/.codex/sessions/${today()}`],
    async read(g) {
      const c = toml(g["F:~/.codex/config.toml"]);
      return {
        today: count(g[`T:~/.codex/sessions/${today()}`]) ?? 0,
        sections: [
          { title: "MCP servers", scope: "user", rows: c.mcp },
          { title: "Skills", scope: "user", rows: skills(g["S:~/.codex/skills"]).map((s) => ({ name: s.name, what: s.about })) },
          { title: "Plugins", scope: "user", rows: c.plugins.map((p) => ({ name: p.name, what: "", off: p.off })) },
        ],
      };
    },
  }),
  gemini: () => ({
    ops: ["F:~/.gemini/settings.json", "L:~/.gemini/extensions", "S:~/.gemini/skills"],
    async read(g) {
      const s = json(g["F:~/.gemini/settings.json"]);
      return {
        today: null,
        sections: [
          { title: "MCP servers", scope: "user", rows: servers(s?.mcpServers, s?.mcp?.excluded ?? []) },
          { title: "Skills", scope: "user", rows: skills(g["S:~/.gemini/skills"]).map((x) => ({ name: x.name, what: x.about })) },
          { title: "Extensions", scope: "user", rows: files(g["L:~/.gemini/extensions"], /\/$/).map((n) => ({ name: n.replace(/\/$/, ""), what: "" })) },
        ],
      };
    },
  }),
  agy: () => ({
    ops: ["F:~/.gemini/antigravity-cli/mcp_config.json", "F:~/.gemini/config/mcp_config.json", "S:~/.gemini/antigravity-cli/skills", "S:~/.gemini/antigravity-cli/builtin/skills"],
    async read(g) {
      return {
        today: null,
        sections: [
          { title: "MCP servers", scope: "user", rows: [...servers(json(g["F:~/.gemini/antigravity-cli/mcp_config.json"])?.mcpServers), ...servers(json(g["F:~/.gemini/config/mcp_config.json"])?.mcpServers)] },
          { title: "Skills", scope: "user", rows: skills(g["S:~/.gemini/antigravity-cli/skills"]).map((s) => ({ name: s.name, what: s.about })) },
          { title: "Skills", scope: "built in", rows: skills(g["S:~/.gemini/antigravity-cli/builtin/skills"]).map((s) => ({ name: s.name, what: s.about })) },
        ],
      };
    },
  }),
};

// A folder's own (project scope) settings, for every agent: → [{ agent, sections }]
async function project(machine, dir) {
  const sys = await system(machine);
  const j = (rel) => `${dir.replace(/[\\/]+$/, "")}/${rel}`;
  const ops = [
    "F:~/.claude.json", `F:${j(".mcp.json")}`, `F:${j(".claude/settings.json")}`, `F:${j(".claude/settings.local.json")}`, `S:${j(".claude/skills")}`, `L:${j(".claude/commands")}`, `L:${j(".claude/agents")}`,
    `F:${j(".codex/config.toml")}`, `S:${j(".codex/skills")}`, `S:${j(".agents/skills")}`,
    `F:${j(".gemini/settings.json")}`, `S:${j(".gemini/skills")}`, `L:${dir}`,
  ];
  const g = await gather(machine, ops);
  const top = files(g[`L:${dir}`], /^[^/]+$/);
  const has = (n) => top.includes(n);
  // Claude's local scope: this folder's entry in ~/.claude.json (Windows keys use / or \).
  const projects = json(g["F:~/.claude.json"])?.projects ?? {};
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const local = Object.entries(projects).find(([k]) => (sys.posix ? k.replace(/\/+$/, "") === dir.replace(/\/+$/, "") : norm(k) === norm(dir)))?.[1];
  const settings = { ...(json(g[`F:${j(".claude/settings.json")}`]) ?? {}), ...(json(g[`F:${j(".claude/settings.local.json")}`]) ?? {}) };
  const offMcp = settings.disabledMcpjsonServers ?? [];
  const shared = skills(g[`S:${j(".agents/skills")}`]).map((s) => ({ name: s.name, what: s.about }));
  const codex = toml(g[`F:${j(".codex/config.toml")}`]);
  const gem = json(g[`F:${j(".gemini/settings.json")}`]);
  return [
    { agent: "claude", name: "Claude Code", sections: [
      { title: "MCP servers", scope: "project · .mcp.json", rows: servers(json(g[`F:${j(".mcp.json")}`])?.mcpServers, offMcp) },
      { title: "MCP servers", scope: "local · ~/.claude.json", rows: servers(local?.mcpServers, local?.disabledMcpServers ?? []) },
      { title: "Skills", scope: ".claude/skills", rows: skills(g[`S:${j(".claude/skills")}`]).map((s) => ({ name: s.name, what: s.about })) },
      { title: "Commands", scope: ".claude/commands", rows: files(g[`L:${j(".claude/commands")}`], /\.md$/i).map((n) => ({ name: `/${n.replace(/\.md$/i, "")}`, what: "" })) },
      { title: "Subagents", scope: ".claude/agents", rows: files(g[`L:${j(".claude/agents")}`], /\.md$/i).map((n) => ({ name: n.replace(/\.md$/i, ""), what: "" })) },
      { title: "Plugins", scope: ".claude/settings.json", rows: Object.entries(settings.enabledPlugins ?? {}).map(([n, on]) => ({ name: n, what: "", off: on === false })) },
      { title: "Instructions", rows: ["CLAUDE.md", "CLAUDE.local.md"].filter(has).map((n) => ({ name: n, what: "" })) },
    ] },
    { agent: "codex", name: "Codex", sections: [
      { title: "MCP servers", scope: ".codex/config.toml", rows: codex.mcp },
      { title: "Skills", scope: ".codex/skills", rows: skills(g[`S:${j(".codex/skills")}`]).map((s) => ({ name: s.name, what: s.about })) },
      { title: "Skills", scope: ".agents/skills", rows: shared },
      { title: "Instructions", rows: ["AGENTS.md", "AGENTS.override.md"].filter(has).map((n) => ({ name: n, what: "" })) },
    ] },
    { agent: "gemini", name: "Gemini / Antigravity", sections: [
      { title: "MCP servers", scope: ".gemini/settings.json", rows: servers(gem?.mcpServers, gem?.mcp?.excluded ?? []) },
      { title: "Skills", scope: ".gemini/skills", rows: skills(g[`S:${j(".gemini/skills")}`]).map((s) => ({ name: s.name, what: s.about })) },
      { title: "Instructions", rows: ["GEMINI.md"].filter(has).map((n) => ({ name: n, what: "" })) },
    ] },
  ];
}

// ---- the dialogs -----------------------------------------------------------------------------------

function section(t, s, i) {
  return v_flex().flex_none().gap(1).pt(i ? 12 : 0)
    .child(h_flex().gap(6).items_center().pb(3)
      .child(div().text_size(11.5).font_bold().text_color(t.foreground).child(s.title))
      .when(Boolean(s.scope), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(s.scope)))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(String(s.rows.length))))
    .when(s.rows.length === 0, (el) => el.child(div().pl(8).text_size(11.5).text_color(t.dim).child(s.note ? `none (${s.note})` : "none")))
    .children(s.rows.map((r) => h_flex().min_h(22).pl(8).gap(10).items_center().rounded(5).hover((x) => x.bg(t.hover))
      .when(r.off, (el) => el.opacity(0.5))
      .child(div().flex_none().max_w(220).truncate().text_size(12).text_color(t.foreground).child(r.name))
      .when(r.off, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("off")))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.what || ""))));
}

const shell = (t, handle, title, sub, body) => v_flex().id("k-inspect").track_focus(handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
  .child(h_flex().flex_none().h(44).px(16).gap(10).items_center().border_b(1).border_color(t.border)
    .child(div().text_size(14).font_bold().child(title))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(sub))
    .child(div().id("k-inspect-close").size(24).rounded(5).flex().items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props()?.overlay))
      .child(svg("mods/workspace-chrome/x.svg").size(13).text_color(t.muted))))
  .child(body);

// Agents on a machine (user / machine scope).
export class AgentsInfo extends View {
  init(p, cx) {
    this.machine = p?.machine ?? null;
    this.agents = null; this.at = null; this.info = {}; this.error = null;
    this.handle = cx.focus_handle();
    cx.timer.after(30, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try {
        this.agents = (await knownAgents({ on: this.machine })).filter((a) => a.installed);
        this.at = this.agents.find((a) => family(a))?.key ?? this.agents[0]?.key ?? null;
      } catch (e) { this.error = `Could not list the agents: ${e?.message ?? e}`; this.agents = []; }
      cx.notify();
      if (this.at) this.load(this.at, cx);
    });
  }

  load(key, cx) {
    const a = this.agents.find((x) => x.key === key);
    const f = family(a);
    if (!f || this.info[key]) return;
    this.info[key] = { loading: true };
    cx.spawn(async (cx) => {
      try {
        const sys = await system(this.machine);
        const d = USER[f](sys);
        this.info[key] = await d.read(await gather(this.machine, d.ops), this.machine);
      } catch (e) { this.info[key] = { error: String(e?.message ?? e) }; }
      cx.notify();
    });
  }

  // Running now on this machine: its terminals' status, by agent.
  running(a) {
    const here = new Set(spaces().filter((s) => (s.machine ?? null) === this.machine).flatMap((s) => (s.tabs ?? []).map((c) => c.id)));
    const mine = panes().filter((p) => here.has(p.tab) && p.program?.agent && (p.program.key === a.key || family(p.program) === family(a)));
    const by = {};
    for (const p of mine) by[p.status ?? "idle"] = (by[p.status ?? "idle"] ?? 0) + 1;
    return { total: mine.length, by };
  }

  render(cx) {
    const t = theme();
    const list = this.agents ?? [];
    const a = list.find((x) => x.key === this.at);
    const info = a ? this.info[a.key] : null;
    const left = v_flex().id("k-ia-list").w(190).h_full().flex_none().p(8).gap(2).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .when(this.agents === null, (el) => el.child(div().p(8).text_color(t.dim).child("Checking installed agents…")))
      .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.blocked).child(this.error)))
      .children(list.map((x) => {
        const r = this.running(x);
        return h_flex().id(`k-ia-${x.key}`).h(32).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .when(x.key === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.at = x.key; this.load(x.key, cx); cx.notify(); })
          .child(x.tint ? svg(x.icon).size(15).text_color(t.foreground) : image(x.icon).size(15))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(x.name))
          .when(r.total > 0, (el) => el.child(div().text_size(10.5).text_color(r.by.working ? t.working : r.by.blocked ? t.blocked : t.dim).child(String(r.total))));
      }));
    let right;
    if (!a) right = div().flex_1();
    else {
      const r = this.running(a);
      const status = ["working", "blocked", "done", "idle"].filter((s) => r.by[s]).map((s) => `${r.by[s]} ${s}`).join(" · ") || "none";
      const head = v_flex().flex_none().gap(4).pb(12).mb(10).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().text_size(15).font_bold().child(a.name)).child(div().text_size(11).text_color(t.dim).child(a.run.join(" "))))
        .child(h_flex().gap(16).text_size(12)
          .child(div().text_color(t.muted).child(`Running now: ${status}`))
          .when(info?.today != null, (el) => el.child(div().text_color(t.muted).child(`Sessions today: ${info.today}`))));
      const body = !family(a) ? [div().text_color(t.dim).text_size(12).child(`k-spaces doesn't know where ${a.name} keeps its MCP servers and skills.`)]
        : !info || info.loading ? [div().text_color(t.dim).text_size(12).child("Reading its settings…")]
        : info.error ? [div().text_color(t.blocked).text_size(12).child(info.error)]
        : info.sections.map((s, i) => section(t, s, i));
      right = v_flex().flex_1().h_full().min_w(0).min_h(0).p(16).child(head).child(v_flex().id("k-ia-body").flex_1().min_h(0).overflow_y_scrollbar().children(body));
    }
    return shell(t, this.handle, "Agents", this.machine ?? "This computer", h_flex().flex_1().min_h(0).items_start().child(left).child(right));
  }
}

// What a space's folder adds (project scope).
export class ProjectInfo extends View {
  init(p, cx) {
    this.machine = p?.machine ?? null;
    this.path = p?.path ?? "";
    this.name = p?.name ?? "";
    this.data = null; this.error = null;
    this.handle = cx.focus_handle();
    cx.timer.after(30, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try { this.data = this.path ? await project(this.machine, this.path) : []; } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    let body;
    if (!this.path) body = [div().text_color(t.dim).text_size(12).child("This space has no folder yet.")];
    else if (this.error) body = [div().text_color(t.blocked).text_size(12).child(this.error)];
    else if (!this.data) body = [div().text_color(t.dim).text_size(12).child("Reading the folder…")];
    else {
      const groups = this.data.map((g) => ({ ...g, sections: g.sections.filter((s) => s.rows.length) })).filter((g) => g.sections.length);
      body = groups.length === 0 ? [div().text_color(t.dim).text_size(12).child("Nothing project-scoped here: no .mcp.json, skills, commands or agent instructions.")]
        : groups.map((g, i) => v_flex().flex_none().pt(i ? 18 : 0)
          .child(div().pb(8).text_size(13.5).font_bold().child(g.name))
          .children(g.sections.map((s, j) => section(t, s, j))));
    }
    const sub = [this.name, this.machine, this.path].filter(Boolean).join(" · ");
    return shell(t, this.handle, "MCP & Skills", sub, v_flex().id("k-ip-body").flex_1().min_h(0).p(16).overflow_y_scrollbar().children(body));
  }
}

export const openAgentsInfo = (openOverlay, machine) => openOverlay({ mod: "k-spaces", kind: "dialog", width: 760, height: 540, props: { agentsInfo: true, machine: machine ?? null } });
export const openProjectInfo = (openOverlay, t) => openOverlay({ mod: "k-spaces", kind: "dialog", width: 640, height: 540, props: { projectInfo: true, machine: t.machine ?? null, path: t.path ?? "", name: t.name ?? "" } });
