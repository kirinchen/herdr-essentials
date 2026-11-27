// k-attach paste shot (herdr-essentials): when the clipboard holds an image, a button saves it
// as a PNG and pastes that file's path into the focused terminal, the way Attach does (Claude
// Code turns it into an image). Herdr's own Ctrl+V on Windows only pastes text.
import { exec, notify, window, shared, setShared } from "herdr";
import { pasteFiles } from "./attach.js";

const PS = (body) => ["-NoProfile", "-STA", "-Command",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " + body];

// Unix: is there an image (PNG) on the clipboard? Wayland wl-paste, else X11 xclip, macOS osascript.
const SH_HAS = `has() {
  if [ "$(uname)" = Darwin ]; then osascript -e 'clipboard info' 2>/dev/null | grep -q PNGf; return; fi
  if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null; then wl-paste --list-types 2>/dev/null
  else xclip -selection clipboard -t TARGETS -o 2>/dev/null; fi | grep -qx 'image/png'
}`;

// Waits until the clipboard's "has an image" differs from `had`, then prints 1 or 0. One small
// process at a time instead of a new one every tick; after 5 minutes by the clock (a locked screen
// makes each round slower) it prints the old state, well inside exec's 10-minute limit.
function watchArgs(platform, had) {
  const h = had ? 1 : 0;
  if (platform === "windows") return ["powershell.exe", PS(
    `$h = ${had ? "$true" : "$false"}; $t = [Diagnostics.Stopwatch]::StartNew(); while ($t.Elapsed.TotalSeconds -lt 300) { ` +
    // Locked screen: the clipboard can't be opened and this throws; keep waiting instead of answering.
    `try { $c = [Windows.Forms.Clipboard]::ContainsImage() } catch { Start-Sleep -Seconds 1; continue }; ` +
    `if ($c -ne $h) { if ($c) { '1' } else { '0' }; exit }; Start-Sleep -Seconds 1 }; '${h}'`)];
  return ["sh", ["-c", `${SH_HAS}
end=$(( $(date +%s) + 300 )); while [ $(date +%s) -lt $end ]; do if has; then c=1; else c=0; fi; [ $c != ${h} ] && { echo $c; exit 0; }; sleep 1; done; echo ${h}`]];
}

// Calls `onChange(hasImage)` whenever that changes. Only the newest watcher in this app home keeps
// going: a reloaded mod starts a new one, and the old one stops when its process comes back.
// `wait(ms)` pauses; a watcher that fails or comes back unchanged too soon backs off, never gives up.
export async function watchClipboard(onChange, wait) {
  const platform = window()?.platform ?? "linux";
  const me = `${Date.now()}-${Math.random()}`;
  setShared("k.clip.watcher", me);
  let had = false;
  while (shared("k.clip.watcher") === me) {
    let r;
    const started = Date.now();
    try { const [cmd, args] = watchArgs(platform, had); r = await exec(cmd, args, { timeout: 600000 }); } catch { await wait(60000); continue; }
    if (shared("k.clip.watcher") !== me) return;
    if (r.code !== 0) { await wait(60000); continue; }
    const now = r.stdout.trim().endsWith("1");
    if (now !== had) { had = now; onChange(now); }
    else if (Date.now() - started < 5000) await wait(30000);
  }
}

// Clipboard image -> a new PNG in the temp folder; its path, or null.
async function save(platform) {
  const d = new Date(), two = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  if (platform === "windows") {
    const r = await exec("powershell.exe", PS(
      "$i = [Windows.Forms.Clipboard]::GetImage(); if (-not $i) { exit 1 }; " +
      `$p = Join-Path ([IO.Path]::GetTempPath()) 'herdr-shot-${stamp}.png'; $i.Save($p, [Drawing.Imaging.ImageFormat]::Png); $p`));
    return r.code === 0 ? r.stdout.trim() : null;
  }
  const r = await exec("sh", ["-c", `f="\${TMPDIR:-/tmp}"; f="\${f%/}/herdr-shot-${stamp}.png"
if [ "$(uname)" = Darwin ]; then osascript -e "set fh to open for access POSIX file \\"$f\\" with write permission" -e 'write (the clipboard as «class PNGf») to fh' -e 'close access fh' >/dev/null
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null; then wl-paste --type image/png > "$f"
else xclip -selection clipboard -t image/png -o > "$f"; fi
[ -s "$f" ] && echo "$f"`]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Put the PNG back on the clipboard (pasting borrowed it for the path).
function putBack(platform, file) {
  const q = file.replace(/'/g, "''");
  if (platform === "windows") return exec("powershell.exe", PS(`[Windows.Forms.Clipboard]::SetImage([Drawing.Image]::FromFile('${q}'))`));
  return exec("sh", ["-c", `if [ "$(uname)" = Darwin ]; then osascript -e "set the clipboard to (read (POSIX file \\"$1\\") as «class PNGf»)"
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null; then wl-copy --type image/png < "$1" >/dev/null 2>&1 &
else xclip -selection clipboard -t image/png -i "$1" >/dev/null 2>&1 & fi`, "sh", file]);
}

export async function pasteShot(cx) {
  const platform = window()?.platform ?? "linux";
  const file = await save(platform);
  if (!file) { notify({ title: "Paste shot", body: "No image on the clipboard.", level: "warning" }); return; }
  await pasteFiles(cx, [file], () => { putBack(platform, file); });
}
