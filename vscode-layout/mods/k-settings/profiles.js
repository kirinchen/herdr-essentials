// k-settings Profiles page (herdr-essentials, was k-profiles): more Herdr windows, each with its own app home (its own
// layout, settings and which space it shows; the terminals are the same ones), and a fixed shortcut for each: Start menu on Windows, app menu on Linux.
// A profile is a folder beside the default home (~/.config/herdr-app-<name>); the list lives beside
// them in herdr-profiles.json so every window sees the same profiles.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, writeTextFile, theme, props, closeOverlay, notify, window } from "herdr";

const sep = () => (window()?.platform === "windows" ? "\\" : "/");
// Profiles sit beside this window's home (normally ~/.config), so a test home keeps its own.
const config = () => appHome().replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
const LIST = () => `${config()}${sep()}herdr-profiles.json`;
const DEFAULT = () => `${config()}${sep()}herdr-app`;
const same = (a, b) => (a ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === (b ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const slug = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// What a new profile starts from: this window's look and mods, not its spaces or window state.
const CARRY = ["layouts", "mods", "themes", "settings.json", "keys.json", "programs.json", "shared.json", "seen.json", "update-notes.json"];

async function load() {
  let text = null;
  try { text = await readTextFile(LIST()); } catch {}
  let list = [];
  try { list = JSON.parse(text ?? "[]"); } catch {}
  return { text, list: Array.isArray(list) ? list.filter(p => p && p.name && p.home) : [] };
}

async function save(state, list) {
  const text = JSON.stringify(list, null, 2) + "\n";
  await writeTextFile(LIST(), text, state.text);
  state.text = text; state.list = list;
}

const fail = (title, r) => { notify({ title, body: ((r?.stderr || r?.stdout || String(r)) + "").trim().slice(0, 300) || "failed", level: "error" }); return false; };

// Make the home (copied from this window's), then its shortcut. A folder that's already there (left
// by a removed profile, or made by hand) is filled in: whatever it lacks is copied, one level into
// layouts / mods / themes, and nothing it has is overwritten.
async function create(name, homeDir) {
  const from = appHome();
  if (window()?.platform === "windows") {
    const r = await exec("powershell.exe", ["-NoProfile", "-Command",
      `$ErrorActionPreference='Stop'; $from=${ps(from)}; $to=${ps(homeDir)}; New-Item -ItemType Directory -Force -Path $to | Out-Null; ` +
      `foreach ($n in @(${CARRY.map(ps).join(",")})) { $p = Join-Path $from $n; if (-not (Test-Path -LiteralPath $p)) { continue }; $d = Join-Path $to $n; ` +
      `if (-not (Test-Path -LiteralPath $d)) { Copy-Item -LiteralPath $p -Destination $to -Recurse -Force } ` +
      `elseif ((Get-Item -LiteralPath $p).PSIsContainer) { foreach ($c in Get-ChildItem -LiteralPath $p -Force) { ` +
      `if (-not (Test-Path -LiteralPath (Join-Path $d $c.Name))) { Copy-Item -LiteralPath $c.FullName -Destination $d -Recurse -Force } } } }`]);
    if (r.code !== 0) return fail("Couldn't make the profile", r);
  } else {
    const r = await exec("sh", ["-c", `mkdir -p "$2" || exit 1
for n in ${CARRY.join(" ")}; do s="$1/$n"; d="$2/$n"; [ -e "$s" ] || continue
  if [ ! -e "$d" ]; then cp -R "$s" "$2/" || exit 1
  elif [ -d "$s" ]; then for c in "$s"/* "$s"/.[!.]*; do [ -e "$c" ] || [ -L "$c" ] || continue; [ -e "$d/\${c##*/}" ] || [ -L "$d/\${c##*/}" ] || cp -R "$c" "$d/" || exit 1; done; fi
done; exit 0`, "sh", from, homeDir]);
    if (r.code !== 0) return fail("Couldn't make the profile", r);
  }
  return shortcut(name, homeDir);
}

// Windows: a .lnk in the Start menu runs a tiny .vbs in the profile's home (sets HERDR_APP_HOME,
// starts herdr-app with no console flash). Linux: a .desktop entry in the app menu.
async function shortcut(name, homeDir) {
  const platform = window()?.platform;
  if (platform === "windows") {
    const r = await exec("powershell.exe", ["-NoProfile", "-Command",
      `$ErrorActionPreference='Stop'; $h=${ps(homeDir)}; $exe=(Get-Command herdr-app -ErrorAction SilentlyContinue).Source; if (-not $exe) { throw 'herdr-app is not on PATH' }; ` +
      `$vbs=Join-Path $h 'open-herdr.vbs'; ` +
      // Each line in its own parentheses: in PowerShell "," binds tighter than "+", so unwrapped they join into one line.
      `$q=[char]34; Set-Content -LiteralPath $vbs -Encoding Unicode -Value @(('Set s = CreateObject(' + $q + 'WScript.Shell' + $q + ')'), ('s.Environment(' + $q + 'Process' + $q + ')(' + $q + 'HERDR_APP_HOME' + $q + ') = ' + $q + $h + $q), ('s.Run ' + $q + $q + $q + $exe + $q + $q + $q + ', 1, False')); ` +
      `$lnk=Join-Path ([Environment]::GetFolderPath('Programs')) ${ps(`Herdr (${name}).lnk`)}; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($lnk); ` +
      `$s.TargetPath=Join-Path $env:WINDIR 'System32\\wscript.exe'; $s.Arguments=$q + $vbs + $q; $s.IconLocation="$exe,0"; $s.Description=${ps(`Herdr window: ${name}`)}; $s.Save(); $lnk`]);
    return r.code === 0 ? true : fail("Couldn't make the shortcut", r);
  }
  if (platform === "linux") {
    const r = await exec("sh", ["-c", `exe=$(command -v herdr-app) || { echo "herdr-app is not on PATH" >&2; exit 1; }
set -- "\${XDG_DATA_HOME:-$HOME/.local/share}/applications/herdr-app-$1.desktop" "$2" "$3"
mkdir -p "$(dirname "$1")" && printf '[Desktop Entry]\\nType=Application\\nName=Herdr (%s)\\nComment=Herdr window with its own layout and settings\\nExec=env "HERDR_APP_HOME=%s" "%s"\\nIcon=herdr-app\\nTerminal=false\\nCategories=Development;\\n' "$2" "$3" "$exe" > "$1"`,
      "sh", slug(name), name, homeDir]);
    return r.code === 0 ? true : fail("Couldn't make the shortcut", r);
  }
  notify({ title: "Profile made", body: "No shortcut on this system yet: open it from Profiles.", level: "info" });
  return true;
}

async function unshortcut(name) {
  if (window()?.platform === "windows")
    await exec("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) ${ps(`Herdr (${name}).lnk`)}) -ErrorAction SilentlyContinue`]);
  else if (window()?.platform === "linux")
    await exec("sh", ["-c", `rm -f "\${XDG_DATA_HOME:-$HOME/.local/share}/applications/herdr-app-$1.desktop"`, "sh", slug(name)]);
}

// Another window on that home. It must not inherit this window's HERDR_APP_HOME, so it's set every time.
async function open(homeDir) {
  const r = window()?.platform === "windows"
    ? await exec("powershell.exe", ["-NoProfile", "-Command", `$env:HERDR_APP_HOME=${ps(homeDir)}; Start-Process -FilePath herdr-app`])
    : await exec("sh", ["-c", `HERDR_APP_HOME="$1" setsid -f herdr-app >/dev/null 2>&1 </dev/null || HERDR_APP_HOME="$1" nohup herdr-app >/dev/null 2>&1 </dev/null &`, "sh", homeDir]);
  if (r.code !== 0) fail("Couldn't open the window", r);
}

export default class Profiles extends View {
  init(_props, cx) {
    this.embedded = Boolean(_props?.embedded); // a page of k-settings, not its own dialog
    this.state = { text: null, list: [] };
    this.busy = null; this.name = "";
    this.input = InputState.new({ value: "", placeholder: "New profile name, e.g. b or work" });
    this.input.on("change", (_e, cx) => { this.name = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { this.state = await load(); cx.notify(); });
  }

  add(cx) {
    const name = this.name.trim(), id = slug(name);
    if (!id || this.busy) return;
    if (id === "default" || this.state.list.some(p => slug(p.name) === id)) { notify({ title: "Profiles", body: `"${name}" is taken.`, level: "warning" }); return; }
    const homeDir = `${DEFAULT()}-${id}`;
    this.busy = "add"; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (await create(name, homeDir)) {
          this.state = await load();
          await save(this.state, [...this.state.list, { name, home: homeDir }]);
          this.name = ""; this.input.set_value("");
        }
      } catch (e) { fail("Couldn't save the profile list", e); }
      this.busy = null; cx.notify();
    });
  }

  forget(p, cx) {
    this.busy = p.home; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await unshortcut(p.name);
        this.state = await load();
        await save(this.state, this.state.list.filter(x => !same(x.home, p.home)));
        notify({ title: "Profile removed", body: `Its shortcut is gone; the folder stays: ${p.home}`, level: "info" });
      } catch (e) { fail("Couldn't save the profile list", e); }
      this.busy = null; cx.notify();
    });
  }

  render() {
    const t = theme(), p = props() ?? {};
    const here = appHome();
    const rows = [{ name: "default", home: DEFAULT(), fixed: true }, ...this.state.list];
    const button = (id, text, primary, action, off) => h_flex().id(id).h(28).px(11).items_center().rounded(7).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .when(Boolean(off), el => el.opacity(0.5)).when(!off, el => el.cursor_pointer().hover(s => s.opacity(0.88)).on_click(action)).child(text);
    const row = (r, i) => {
      const current = same(r.home, here);
      return h_flex().id(`profile-${i}`).h(44).px(10).gap(10).items_center().rounded(8).when(current, el => el.bg(t.selected))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).items_center().child(div().font_semibold().truncate().child(r.name))
            .when(current, el => el.child(div().text_size(10.5).text_color(t.dim).child("this window"))))
          .child(div().text_size(11).text_color(t.dim).truncate().child(r.home)))
        .when(!current, el => el.child(button(`open-${i}`, "Open", false, () => open(r.home))))
        .when(!r.fixed && !current, el => el.child(div().id(`forget-${i}`).size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .tooltip("Remove from the list and delete its shortcut; its folder stays").hover(s => s.bg(t.hover).text_color(t.foreground))
          .when(this.busy !== r.home, el => el.on_click((_e, cx) => this.forget(r, cx)))
          .child(svg("mods/workspace-chrome/x.svg").size(13))));
    };
    return v_flex().id("k-profiles").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).gap(10).when(!this.embedded, el => el.bg(t.popover)).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Profiles"))
        .when(!this.embedded, el => el.child(div().text_size(11).text_color(t.dim).child("Esc"))))
      .child(div().text_size(12).text_color(t.muted).child(window()?.platform === "windows"
        ? "Each profile is another Herdr window with its own layout, settings and shown space (same terminals). It gets a Start menu entry, \"Herdr (name)\"."
        : "Each profile is another Herdr window with its own layout, settings and shown space (same terminals). It gets an app menu entry, \"Herdr (name)\"."))
      .child(v_flex().id("profile-list").max_h(300).min_h(0).overflow_y_scroll().gap(2).children(rows.map(row)))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.input).flex_1().h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(button("add", this.busy === "add" ? "Making…" : "Add", true, (_e, cx) => this.add(cx), !slug(this.name) || Boolean(this.busy))))
      .child(div().text_size(11).text_color(t.dim).child("A new profile starts as a copy of this window's layout, mods and settings."));
  }
}
