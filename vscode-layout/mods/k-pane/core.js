// k-pane: the pure part (no `herdr` import, so `node --test` can load it): what other mods may
// put in a pane header, and which of it one pane shows.
//
// shared "k-pane.chips" = { <mod name>: { <terminal address>: chip } }, each mod writing only its
// own key. A chip: { label?, text?, tone?, tag?, color?, tip?, url? }
//   label: small muted lead ("#290")      text: the main words, cut when narrow
//   tone:  theme color of the text        tag:  a small pill after it, color: its theme color
//   tip:   tooltip                        url:  opened in the browser on click (http / https only)

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// Every mod the layout holds: its blocks' and its pane headers'.
export function modsIn(node, out = new Set()) {
  const c = node?.content;
  if (typeof c?.mod === "string") out.add(c.mod);
  const head = c?.pane?.header?.content?.mod;
  if (typeof head === "string") out.add(head);
  for (const child of node?.children ?? []) modsIn(child, out);
  return out;
}

// Where a pane is: the machine its space lives on (null: this computer) and the space's name (the
// repo, unless someone named it). `tab` is the pane's tab id.
export function placeOf(spaces, tab) {
  const s = (Array.isArray(spaces) ? spaces : []).find((x) => (x?.tabs ?? []).some((t) => t?.id === tab));
  return s ? { machine: s.machine || null, space: str(s.name, 80) } : { machine: null, space: "" };
}

export function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^\s"'<>\\^`{|}]+$/i.test(url) ? url : null;
}

// The chips of one terminal, by mod name. A mod that is no longer in the layout (removed, or
// another layout is shown) is left out: shared data outlives the mod that wrote it.
export function chipsFor(given, address, mods) {
  const out = [];
  if (!address || !given || typeof given !== "object" || Array.isArray(given)) return out;
  for (const by of Object.keys(given).sort()) {
    const g = mods.has(by) ? given[by]?.[address] : null;
    if (!g || typeof g !== "object") continue;
    const chip = {
      by, label: str(g.label, 40), text: str(g.text, 300), tone: str(g.tone, 40), tag: str(g.tag, 40), color: str(g.color, 40),
      tip: typeof g.tip === "string" ? g.tip.slice(0, 1000) : "", url: safeUrl(g.url),
    };
    if (chip.label || chip.text || chip.tag) out.push(chip);
  }
  return out;
}

// The model menu (click the model icon): what to type into the agent. Claude Code takes
// `/model <alias>` and `/effort <level>`; Codex's `/model` opens its own picker (model and
// reasoning effort), so it gets one entry. Other programs: no menu (null).
export const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function switchKind(program) {
  const n = String(program?.name ?? "");
  return /claude/i.test(n) ? "claude" : /codex/i.test(n) ? "codex" : null;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

// m: modelOf's answer (kind = "opus" …, effort), or null. An item: { label, send, now?, rule? }.
export function switchItems(kind, m) {
  if (kind === "claude") return [
    ...CLAUDE_MODELS.map((a) => ({ label: cap(a), send: `/model ${a}`, now: m?.kind === a })),
    ...EFFORTS.map((e, i) => ({ label: `Effort: ${e}`, send: `/effort ${e}`, now: m?.effort === e, rule: i === 0 })),
  ];
  if (kind === "codex") return [{ label: "Model & effort…", send: "/model", hint: "Codex's own picker" }];
  return [];
}

// "laptop/t10" → { on: "laptop", id: "t10" }; "t6n" → { on: null, id: "t6n" }.
export function targetOf(address) {
  const a = String(address ?? "");
  const i = a.indexOf("/");
  return i < 0 ? { on: null, id: a } : { on: a.slice(0, i), id: a.slice(i + 1) };
}
