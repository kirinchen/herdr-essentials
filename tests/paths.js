// Where the mods are: each package is a folder laid out like an App home (<package>/mods/<mod>/),
// as the gallery wants. A mod may sit in more than one package (the layout carries k-attach).
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// [{ pkg, name, dir }] for every mod folder in every package.
export function modDirs() {
  const out = [];
  for (const pkg of readdirSync(ROOT)) {
    const m = join(ROOT, pkg, "mods");
    if (!existsSync(m)) continue;
    for (const name of readdirSync(m)) out.push({ pkg, name, dir: join(m, name) });
  }
  return out;
}
export const modDir = (pkg, name) => join(ROOT, pkg, "mods", name);
