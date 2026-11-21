// k-chat: Claude Code transcripts (~/.claude/projects/<folder>/<session>.jsonl) as cards.
// Pure functions, no host calls: main.js reads the file, this turns lines into cards.
// Tested by tests/k-chat.test.js.

// Claude Code's folder name for a cwd: every character that isn't a letter or digit becomes "-".
export const projectDir = (cwd) => String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");

// The session a command line resumes: `--resume <id>`, `-r <id>`, `--resume=<id>`, `--session-id <id>`.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resumeId(argv) {
  const a = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < a.length; i++) {
    const m = a[i].match(/^--(?:resume|session-id)=(.+)$/);
    if (m && UUID.test(m[1])) return m[1];
    if (["--resume", "-r", "--session-id"].includes(a[i]) && UUID.test(a[i + 1] ?? "")) return a[i + 1];
  }
  return null;
}

// Which file: Claude Code's own record for the process (~/.claude/sessions/<pid>.json, kept
// current across /clear and /resume), else the id on the command line, else the newest
// transcript of the folder. Prints the session id and the path (empty: none yet).
export const RESOLVE = `
d="$HOME/.claude"; pid="$1"; sid="$2"; cwd="$3"; known=""
s="$d/sessions/$pid.json"
if [ -n "$pid" ] && [ -f "$s" ]; then
  x=$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "$s"); [ -n "$x" ] && { sid="$x"; known=1; }
  c=$(sed -n 's/.*"cwd":"\\([^"]*\\)".*/\\1/p' "$s"); [ -n "$c" ] && cwd="$c"
fi
p="$d/projects/$(printf %s "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"
f=""
if [ -n "$sid" ]; then
  f="$p/$sid.jsonl"
  [ -f "$f" ] || f=$(find "$d/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -n 1)
fi
[ -n "$f" ] || [ -n "$known" ] || f=$(ls -t "$p"/*.jsonl 2>/dev/null | head -n 1)
printf '%s\\n%s\\n' "$sid" "$f"
`;

// Bytes [offset, offset + cap) of the file; a negative offset means its last |offset| bytes.
// First line: its size and where the chunk starts (0 again when the file got shorter).
export const READ = `
f="$1"; o="$2"; n="$3"
[ -f "$f" ] || { echo missing; exit 0; }
s=$(wc -c < "$f" | tr -d ' ')
if [ "$o" -lt 0 ]; then o=$(( s > -o ? s + o : 0 )); fi
[ "$o" -gt "$s" ] && o=0
echo "$s $o"
[ "$o" -lt "$s" ] && tail -c +$((o + 1)) "$f" | head -c "$n"
exit 0
`;

// Bytes in a string as UTF-8, so a read offset can advance by exactly the complete lines used.
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// A chunk read from some byte of the file: the complete lines in it, and how many bytes they
// (and a dropped cut first line) took. `partialStart`: the chunk began mid-line, drop up to "\n".
export function splitChunk(text, partialStart) {
  let from = 0;
  if (partialStart) {
    const nl = text.indexOf("\n");
    if (nl < 0) return { lines: [], used: 0 };
    from = nl + 1;
  }
  const last = text.lastIndexOf("\n");
  if (last < from) return { lines: [], used: utf8Length(text.slice(0, from)) };
  const body = text.slice(from, last);
  return { lines: body ? body.split("\n") : [], used: utf8Length(text.slice(0, last + 1)) };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const tag = (s, name) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

// What a tool call did, in one line: the command, the file, the pattern.
export function toolSummary(name, input) {
  const i = input ?? {};
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.skill ?? "";
  const s = typeof pick === "string" ? pick : JSON.stringify(pick);
  return s.replace(/\s+/g, " ").trim().slice(0, 200) || (Object.keys(i).length ? JSON.stringify(i).replace(/\s+/g, " ").slice(0, 200) : "");
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
}

// What a person typed, or a note for what Claude Code put in their place.
function userText(raw) {
  // A message pasted in (as `hc send` does) is recorded wrapped in <pasted_content id="…"> tags.
  const s = raw.replace(/<pasted_content id="[^"]*">\n?/g, "").replace(/\n?<\/pasted_content id="[^"]*">/g, "");
  const t = s.trim();
  if (!t) return null;
  if (t.startsWith("<task-notification>")) return { note: `Task notification: ${tag(t, "summary") ?? tag(t, "status") ?? ""}`.trim() };
  if (t.startsWith("<local-command-caveat>")) return null;
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-stderr>")) {
    const out = tag(t, "local-command-stdout") ?? tag(t, "local-command-stderr") ?? "";
    return out ? { note: out } : null;
  }
  if (t.includes("<command-name>")) {
    const args = tag(t, "command-args");
    return { text: [tag(t, "command-name"), args].filter(Boolean).join(" ") };
  }
  if (t.startsWith("This session is being continued from a previous conversation")) return { note: "Context compacted: continued from a summary." };
  if (t.startsWith("[Request interrupted")) return { note: "Interrupted." };
  return { text: t };
}

// A transcript's cards, built a line at a time so polling can feed it only what's new.
// Cards: { key, kind: "user" | "ai" | "note", ... }
//   user: { at, text, images }    note: { at, text }
// A Claude card is one reply: its text, then the tool calls it made before the next text.
//   ai:   { at, parts: [{ kind: "text", text } | { kind: "tool", id, name, summary, input, result, error }], usage, model }
export class Chat {
  constructor() {
    this.cards = [];
    this.tools = new Map();
    this.cost = null;
    this.title = null;
    this.version = 0;
  }

  push(lines) {
    for (const line of lines) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      this.add(d);
    }
    this.version++;
  }

  // A Claude card: each reply's text starts one; tool calls go in the card before them.
  ai(d, fresh) {
    const last = this.cards.at(-1);
    if (!fresh && last?.kind === "ai") return last;
    const card = { key: `ai-${d.uuid ?? ""}-${this.cards.length}`, kind: "ai", at: d.timestamp ?? null, parts: [], usage: null, model: null };
    this.cards.push(card);
    return card;
  }

  add(d) {
    if (d.type === "cost-state") { this.cost = { usd: d.totalCostUSD, models: d.modelUsage ?? null }; return; }
    if (d.type === "ai-title" || d.type === "custom-title") { this.title = d.customTitle ?? d.aiTitle ?? d.title ?? this.title; return; }
    if (d.type !== "user" && d.type !== "assistant") return;
    if (d.isSidechain) return;
    const content = d.message?.content;
    if (d.type === "assistant") {
      const id = d.message?.id;
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === "text" && c.text?.trim()) {
          const last = this.cards.at(-1);
          const prev = last?.kind === "ai" ? last.parts.at(-1) : null;
          // A reply streamed as several lines of one message reads as one block.
          if (prev?.kind === "text" && id && prev.msg === id) { prev.text += "\n\n" + c.text; continue; }
          const card = this.ai(d, true);
          card.parts.push({ kind: "text", text: c.text, msg: id });
          this.meta(card, d);
        } else if (c.type === "tool_use") {
          const card = this.ai(d, false);
          const part = { kind: "tool", id: c.id, name: c.name, summary: toolSummary(c.name, c.input), input: c.input, result: null, error: false };
          card.parts.push(part);
          this.tools.set(c.id, part);
          this.meta(card, d);
        }
      }
      return;
    }
    // user
    if (Array.isArray(content) && content.some((c) => c.type === "tool_result")) {
      for (const c of content) {
        if (c.type !== "tool_result") continue;
        const part = this.tools.get(c.tool_use_id);
        if (part) { part.result = clip(resultText(c.content), 20000); part.error = Boolean(c.is_error); }
      }
      return;
    }
    if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
    const texts = typeof content === "string" ? [content] : (Array.isArray(content) ? content : []).filter((c) => c.type === "text").map((c) => c.text);
    const images = Array.isArray(content) ? content.filter((c) => c.type === "image").length : 0;
    const u = userText(texts.join("\n\n"));
    if (!u && !images) return;
    if (u?.note) { this.cards.push({ key: `note-${d.uuid ?? this.cards.length}`, kind: "note", at: d.timestamp ?? null, text: u.note }); return; }
    this.cards.push({ key: `user-${d.uuid ?? this.cards.length}`, kind: "user", at: d.timestamp ?? null, text: u?.text ?? "", images });
  }

  meta(card, d) {
    if (d.message?.usage) card.usage = d.message.usage;
    if (d.message?.model && d.message.model !== "<synthetic>") card.model = d.message.model;
  }
}

// Text as a markdown code block, shown as it is (TextView.html's <pre> loses the font or the lines).
export function fence(s) {
  const longest = Math.max(2, ...(String(s).match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${s}\n${f}`;
}

// Tokens in a short form: 1234 → "1.2k".
export function tokens(n) {
  if (n == null) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// The context a reply saw and what it wrote.
export function usageLine(u) {
  if (!u) return "";
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return `context ${tokens(input)} · out ${tokens(u.output_tokens ?? 0)}`;
}
