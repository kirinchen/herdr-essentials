// The model and effort an agent runs, and the icon that shows both. Pure (no `herdr` import, so
// `node --test` can load it). k-pane carries a copy (a mod can only import from its own folder);
// tests/model.test.js keeps the copies equal:  cp mods/k-agents/model.js mods/k-pane/model.js
//
// From the terminal's labels herdr.model / herdr.effort (Claude Code's statusLine writes them:
// tools/statusline/herdr-statusline.sh), else, for Codex, from its command line (-m / --model,
// -c model_reasoning_effort=...).
// One icon per model (Claude and Codex first), so it says the maker and the tier; the effort tints
// it: nothing for low, a light backing for medium, stronger for high, a ring for xhigh and max.
export const MODELS = [
  [/opus/i, "opus", "#d97757"],
  [/sonnet/i, "sonnet", "#5b8def"],
  [/haiku/i, "haiku", "#3fb37f"],
  [/fable/i, "fable", "#a970ff"],
  [/codex/i, "codex", "#10a37f"],
  [/mini|nano|spark/i, "mini", "#e0a30b"],
  [/gpt|^o\d/i, "gpt", "#10a37f"],
];
function argOf(argv, names) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    for (const n of names) {
      if (a === n && argv[i + 1] != null) return String(argv[i + 1]);
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
}
// `dir`: the folder that holds the m-*.svg icons (each mod has its own).
export function modelOf(term, dir) {
  const l = term?.labels ?? {};
  let model = l["herdr.model"] || null, effort = l["herdr.effort"] || null;
  // A tab's terminal runs its program under a shell (`sh -ic "$@" … codex`): the program's own
  // command line is the foreground one.
  const argv = Array.isArray(term?.foreground?.argv) ? term.foreground.argv : Array.isArray(term?.argv) ? term.argv : [];
  if (!model && /codex/i.test(String(argv[0] ?? "").split(/[\\/]/).pop())) {
    model = argOf(argv, ["-m", "--model"]);
    const cs = argv.flatMap((a, i) => (a === "-c" || a === "--config") ? [String(argv[i + 1] ?? "")] : String(a).startsWith("--config=") ? [String(a).slice(9)] : []);
    const e = cs.find((c) => /^model_reasoning_effort\s*=/.test(c));
    if (e) effort = e.split("=").slice(1).join("=").replace(/["'\s]/g, "");
  }
  if (!model) return null;
  const hit = MODELS.find(([re]) => re.test(model));
  return hit ? { model, effort: effort ? String(effort).toLowerCase() : null, kind: hit[1], icon: `${dir}/m-${hit[1]}.svg`, color: hit[2] } : { model, effort, kind: null, icon: null, color: null };
}
// How strongly the effort shows: 0 nothing, 1 light backing, 2 stronger, 3 with a ring.
export function effortLevel(e) {
  return e === "max" || e === "xhigh" ? 3 : e === "high" ? 2 : e === "medium" ? 1 : 0;
}
// "Fable 5.2 · high"
export function modelTip(m) {
  return m ? [m.model, m.effort].filter(Boolean).join(" \u00b7 ") : "";
}
