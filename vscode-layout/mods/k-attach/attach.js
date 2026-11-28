// k-attach (herdr-essentials): pick files with the system dialog and paste their paths
// into the focused terminal, without Enter, the way dropping files does. Claude Code turns a
// pasted image path into an image attachment.
import { exec, hc, run, focused, spaces, notify, window } from "herdr";

const PS_PICK = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
  "$d = New-Object System.Windows.Forms.OpenFileDialog -Property @{ Multiselect = $true; Title = 'Attach files' }",
  "if ($d.ShowDialog($o) -eq 'OK') { $d.FileNames -join \"`n\" }",
].join("; ");

// The system file dialog: absolute paths, [] when cancelled.
async function pick(platform) {
  const long = { timeout: 600000 };
  const lines = (r) => r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (platform === "windows") {
    const r = await exec("powershell.exe", ["-NoProfile", "-STA", "-Command", PS_PICK], long);
    return r.code === 0 ? lines(r) : [];
  }
  if (platform === "macos") {
    const r = await exec("osascript", ["-e", 'set fs to choose file with prompt "Attach files" with multiple selections allowed', "-e", 'set out to ""', "-e", "repeat with f in fs", "-e", 'set out to out & POSIX path of f & linefeed', "-e", "end repeat", "-e", "out"], long);
    return r.code === 0 ? lines(r) : [];
  }
  try {
    const r = await exec("zenity", ["--file-selection", "--multiple", "--separator=\n", "--title=Attach files"], long);
    return r.code === 0 ? lines(r) : [];
  } catch {
    const r = await exec("kdialog", ["--getopenfilename", "--multiple", "--separate-output", "."], long);
    return r.code === 0 ? lines(r) : [];
  }
}

// Quoted like a file drop: bare when safe, else '…' (Unix) or "…" (Windows).
export function quote(path, windows) {
  if (/^[\w.\/@%+=:,~-]+$/.test(path) && !windows) return path;
  if (windows) return /[\s&()^;,']/.test(path) ? `"${path}"` : path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export async function attach(cx) {
  const terminal = focused()?.terminal;
  if (!terminal) { notify({ title: "Attach", body: "Click a terminal first.", level: "warning" }); return; }
  const files = await pick(window()?.platform ?? "linux");
  if (files.length) await pasteFiles(cx, files);
}

// Paste files' paths into the focused terminal, no Enter. `restore(cx, before)` gives the
// clipboard back afterwards; by default the person's text goes back.
export async function pasteFiles(cx, files, restore = (cx, before) => { if (before !== undefined) cx.write_to_clipboard(before); }) {
  const f = focused();
  const terminal = f?.terminal;
  if (!terminal) return false;
  const platform = window()?.platform ?? "linux";
  // A terminal on another machine gets copies beside it, like a file drop onto it.
  const machine = spaces().find(s => s.id === f.space)?.machine ?? null;
  let paths = files, remoteWindows = false;
  if (machine) {
    paths = [];
    for (const file of files) {
      const r = await hc(["put", terminal.includes("/") ? terminal : `${machine}/${terminal}`, file, "--json"]);
      if (r.code !== 0) { notify({ title: "Attach failed", body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" }); return false; }
      let landed = r.stdout.trim();
      try { const j = JSON.parse(landed); landed = j.path ?? j.landed ?? j.file ?? Object.values(j).find(v => typeof v === "string") ?? landed; } catch {}
      paths.push(landed);
      remoteWindows ||= /^[A-Za-z]:\\/.test(landed);
    }
  }
  const windows = machine ? remoteWindows : platform === "windows";
  const text = paths.map(p => quote(p, windows)).join(" ") + " ";
  // terminal.paste reads the clipboard: borrow it, then give it back.
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal });
  run("terminal.paste");
  cx.timer.after(600, (cx) => { if (cx.read_from_clipboard() === text) restore(cx, before); });
  return true;
}
