// Is another mod installed in this App home? Some entries open a mod that comes in its own package
// (k-chat, k-pick): without it they are left out. Assumed there until the check says otherwise.
import { readTextFile, appHome } from "herdr";

export const has = {};
export async function check(names) {
  const home = appHome().replace(/[\\/]+$/, "");
  for (const n of names) {
    try { has[n] = (await readTextFile(`${home}/mods/${n}/mod.json`)) != null; } catch { has[n] = false; }
  }
}
export const there = (name) => has[name] !== false;
