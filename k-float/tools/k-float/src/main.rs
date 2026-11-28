//! k-float: opens always-on-top desktop windows from spec files.
//!
//!   k-float start <dir>   start a detached helper for <dir> (no-op if one is running), then exit
//!   k-float run <dir>     run in the foreground
//!   k-float stop <dir>    ask the helper for <dir> to exit
//!
//! <dir>/windows/<id>.json   one window (written by a mod, an agent or a script)
//! <dir>/events/<id>.jsonl   what happened to it (written here, one JSON object per line)
//! Protocol: doc/k-float-protocol.md

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{ResizeDirection, Window, WindowBuilder, WindowId};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const POLL: Duration = Duration::from_millis(200);
const SETTLE: Duration = Duration::from_millis(400);
const EVENTS_MAX_BYTES: u64 = 256 * 1024;
const EVENTS_KEEP_LINES: usize = 200;

/// Runs in every page before its own scripts (after `window.__floatFrameless` is set).
/// Messages that start with \u0001 are for the helper (move, resize, close, minimize, collapse,
/// expand), not the mod.
const PAGE_API: &str = r#"
(() => {
  const ctl = (c) => window.ipc.postMessage("\u0001" + c);
  // <html data-float-collapsed> while collapsed: a page can switch its look with CSS alone.
  const mark = (on) => { if (document.documentElement) document.documentElement.toggleAttribute("data-float-collapsed", on); };
  mark(!!window.__floatCollapsed);
  addEventListener("DOMContentLoaded", () => mark(window.float.collapsed));
  window.float = {
    data: undefined,
    // Collapsed to a button (the spec's `collapsed`). The helper keeps it current.
    collapsed: !!window.__floatCollapsed,
    _fns: [],
    _cfns: [],
    send(value) { window.ipc.postMessage(JSON.stringify(value === undefined ? null : value)); },
    onData(fn) { this._fns.push(fn); if (this.data !== undefined) fn(this.data); },
    close() { ctl("close"); },
    minimize() { ctl("minimize"); },
    // Shrinks the window to a button of this size (default: the spec's collapsedWidth × collapsedHeight,
    // 44 × 44) / brings it back to the size it had. The page learns the outcome through onCollapsed.
    collapse(size) {
      const w = size ? Number(size.width) : NaN, h = size ? Number(size.height) : NaN;
      ctl(w > 0 && h > 0 ? "collapse:" + w + "," + h : "collapse");
    },
    expand() { ctl("expand"); },
    // fn(collapsed) now, and again whenever it changes (by the page, the spec, or a restart).
    onCollapsed(fn) { this._cfns.push(fn); try { fn(this.collapsed); } catch (e) { console.error(e); } },
    __collapsed(value) {
      value = !!value; mark(value);
      if (value === this.collapsed) return;
      this.collapsed = value;
      for (const fn of this._cfns) { try { fn(value); } catch (e) { console.error(e); } }
    },
    __data(value) { this.data = value; for (const fn of this._fns) { try { fn(value); } catch (e) { console.error(e); } } },
  };
  // Without the system's frame the page is the whole window: elements marked data-float-drag move it,
  // and the outer few pixels resize it (not while collapsed).
  // data-float-drag-click: for something that is also clicked (a button). Pressing and moving it
  // SLOP pixels moves the window and swallows the click; letting go without moving is a plain click.
  const B = 6, CUR = { n: "ns", s: "ns", e: "ew", w: "ew", ne: "nesw", sw: "nesw", nw: "nwse", se: "nwse" };
  const edge = (e) => {
    if (!window.__floatFrameless || window.float.collapsed) return "";
    const x = e.clientX, y = e.clientY;
    return (y < B ? "n" : y >= innerHeight - B ? "s" : "") + (x < B ? "w" : x >= innerWidth - B ? "e" : "");
  };
  const SLOP = 4;
  let style = null, press = null, dragged = false;
  addEventListener("mousemove", (e) => {
    if (picking) return;
    if (press) {
      if (!(e.buttons & 1)) press = null;
      else if (Math.hypot(e.screenX - press.x, e.screenY - press.y) >= SLOP) { press = null; dragged = true; ctl("drag"); }
    }
    const d = edge(e), css = d ? `*{cursor:${CUR[d]}-resize !important}` : "";
    if (!style) { if (!css) return; style = document.createElement("style"); (document.head || document.documentElement).appendChild(style); }
    if (style.textContent !== css) style.textContent = css;
  }, true);
  addEventListener("mousedown", (e) => {
    press = null; dragged = false;
    if (picking || e.button !== 0) return;
    const d = edge(e);
    if (d) { e.preventDefault(); e.stopPropagation(); ctl("resize:" + d); return; }
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest("[data-float-drag-click]") && !t.closest("[data-float-nodrag]")) {
      press = { x: e.screenX, y: e.screenY }; // no preventDefault: it may still become a click
      return;
    }
    if (t && t.closest("[data-float-drag]") && !t.closest("button,input,textarea,select,a,[data-float-nodrag]")) {
      e.preventDefault(); ctl("drag");
    }
  }, true);
  addEventListener("mouseup", () => { press = null; }, true);
  // The click that ends a drag (if the system delivers one at all) is not a click.
  addEventListener("click", (e) => {
    if (!dragged) return;
    dragged = false; e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  // Pointing at an element for an agent (k-pick, which can't see into this window: it isn't Herdr's).
  // On while <dir>/pick exists (k-pick makes it) or after Ctrl+F12 here: the element under the pointer
  // is outlined, a click copies a locator for it, Esc leaves.
  let picking = false, box = null, tag = null, target = null;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&"));
  const step = (el) => {
    if (el.id) return '#' + esc(el.id);
    let s = el.localName;
    for (const c of [...el.classList].slice(0, 2)) s += '.' + esc(c);
    const same = el.parentElement ? [...el.parentElement.children].filter((x) => x.localName === el.localName) : [];
    return same.length > 1 ? s + ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : s;
  };
  const selector = (el) => {
    const parts = [];
    for (let at = el; at && at.nodeType === 1 && at !== document.documentElement && parts.length < 6; at = at.parentElement) {
      parts.unshift(step(at));
      if (at.id) break;
    }
    return parts.join(' > ');
  };
  const ours = (el) => el === box || el === tag;
  const under = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && !ours(el) ? el : null; };
  const outline = (el) => {
    target = el;
    if (!box) {
      box = document.createElement("div"); tag = document.createElement("div");
      box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2f6feb;background:#2f6feb22;box-sizing:border-box;margin:0";
      tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#2f6feb;color:#fff;font:11px/1.5 system-ui,sans-serif;padding:1px 6px;border-radius:4px;max-width:92vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:0";
      document.documentElement.append(box, tag);
    }
    if (!el) { box.style.display = "none"; tag.style.display = ""; tag.style.left = "4px"; tag.style.top = "4px"; tag.textContent = "k-pick · click an element · Esc"; return; }
    const r = el.getBoundingClientRect();
    box.style.display = ""; tag.style.display = "";
    box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
    tag.textContent = step(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    tag.style.left = Math.max(0, Math.min(r.left, innerWidth - 60)) + "px";
    tag.style.top = (r.top >= 20 ? r.top - 20 : Math.min(innerHeight - 20, r.bottom + 2)) + "px";
  };
  const copy = (text) => {
    const done = () => { try {
      const a = document.createElement("textarea"); a.value = text; a.style.cssText = "position:fixed;left:-9999px;top:0";
      document.documentElement.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok;
    } catch (e) { return false; } };
    if (!done() && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  };
  const pickMode = (on) => {
    on = !!on;
    if (on === picking) return;
    picking = on;
    if (on) outline(null);
    else { if (box) { box.remove(); tag.remove(); } box = tag = target = null; }
  };
  window.float.__pick = pickMode;
  const choose = (e) => {
    const el = under(e) || target;
    if (!el) return;
    const r = el.getBoundingClientRect(), n = Math.round;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const loc = [
      "float=" + (window.__floatId || "?"),
      "selector=" + selector(el),
      "tag=" + el.localName,
      text && "text=" + JSON.stringify(text),
      "at=(" + n(e.clientX) + "," + n(e.clientY) + ") in element (" + n(e.clientX - r.left) + "," + n(e.clientY - r.top) + ") of " + n(r.width) + "×" + n(r.height),
      "window=" + innerWidth + "×" + innerHeight,
    ].filter(Boolean).join("  |  ");
    copy(loc);
    ctl("picked:" + loc);
    pickMode(false);
  };
  const eat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  addEventListener("keydown", (e) => {
    if (e.key === "F12" && e.ctrlKey && !e.shiftKey && !e.altKey) { eat(e); if (picking) ctl("pick-off"); pickMode(!picking); return; }
    if (picking && e.key === "Escape") { eat(e); ctl("pick-off"); pickMode(false); }
  }, true);
  addEventListener("mousemove", (e) => { if (picking) outline(under(e)); }, true);
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup"]) {
    addEventListener(type, (e) => {
      if (!picking) return;
      eat(e);
      if (type === "click" && e.button === 0) choose(e);
    }, true);
  }
})();
"#;

fn page_api(id: &str, frame: bool, collapsed: bool) -> String {
    // The id is a file name the helper checked (valid_id): letters, digits, - and _.
    format!("window.__floatId = \"{id}\";\nwindow.__floatFrameless = {};\nwindow.__floatCollapsed = {collapsed};\n{PAGE_API}", !frame)
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Spec {
    html: String,
    data: Value,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    topmost: bool,
    click_through: bool,
    frame: bool,
    taskbar: bool,
    opacity: f64,
    /// Opacity while the person works in a window this one covers (it is not focused and the
    /// active window overlaps it). None: always `opacity`.
    behind_opacity: Option<f64>,
    /// Opacity while the mouse is over the window (focused or not). Wins over the two above.
    hover_opacity: Option<f64>,
    /// Shrunk to a button of `collapsed_width` × `collapsed_height`. `width` / `height` stay the
    /// expanded size; `x` / `y` are where the window is now (the button's corner while collapsed).
    /// Written here when the page collapses / expands; a mod can set it too.
    collapsed: bool,
    collapsed_width: f64,
    collapsed_height: f64,
    /// The corner that stays put when collapsing / expanding: top-right (default), top-left,
    /// bottom-right, bottom-left.
    collapse_anchor: String,
    /// Written here when the person minimizes the window; a mod sets it to false to bring it back.
    minimized: bool,
}

impl Default for Spec {
    fn default() -> Self {
        Spec {
            html: String::new(),
            data: Value::Null,
            title: "k-float".into(),
            x: None,
            y: None,
            width: 320.0,
            height: 240.0,
            topmost: true,
            click_through: false,
            frame: true,
            taskbar: false,
            opacity: 1.0,
            behind_opacity: None,
            hover_opacity: None,
            collapsed: false,
            collapsed_width: COLLAPSED_SIDE,
            collapsed_height: COLLAPSED_SIDE,
            collapse_anchor: "top-right".into(),
            minimized: false,
        }
    }
}

/// A screen's area in logical pixels: x, y, width, height.
type Area = (f64, f64, f64, f64);

/// The smallest width / height taken from a spec; below it the window would be lost.
const MIN_SIDE: f64 = 20.0;

/// The size of a collapsed window when the spec doesn't say, and the smallest one taken from it.
const COLLAPSED_SIDE: f64 = 44.0;
const COLLAPSED_MIN: f64 = 16.0;
/// A collapsed window keeps showing as hovered this long after the mouse left: passing over its
/// edge doesn't flicker.
const HOVER_LEAVE: Duration = Duration::from_millis(150);
const POINTER_POLL: Duration = Duration::from_millis(50);

/// The size of the window while collapsed.
fn collapsed_size(spec: &Spec) -> (f64, f64) {
    let side = |v: f64| if v.is_finite() && v >= COLLAPSED_MIN { v.round() } else { COLLAPSED_SIDE };
    (side(spec.collapsed_width), side(spec.collapsed_height))
}

/// The size the window has on the screen: `width` × `height`, or the button's while collapsed.
fn shown_size(spec: &Spec) -> (f64, f64) {
    if spec.collapsed { collapsed_size(spec) } else { (spec.width, spec.height) }
}

/// How far the window's top-left moves when its size goes `from` -> `to` and the anchor corner stays.
fn anchor_shift(anchor: &str, from: (f64, f64), to: (f64, f64)) -> (f64, f64) {
    let a = anchor.to_ascii_lowercase();
    (if a.contains("left") { 0.0 } else { from.0 - to.0 }, if a.contains("bottom") { from.1 - to.1 } else { 0.0 })
}

/// Moves a window of this size wholly onto the screen that holds `near` (else the first one). A
/// window bigger than the screen starts at the screen's corner.
fn onto_screen((x, y): (f64, f64), (w, h): (f64, f64), near: (f64, f64), screens: &[Area]) -> (f64, f64) {
    let holds = |&&(sx, sy, sw, sh): &&Area| near.0 >= sx && near.0 < sx + sw && near.1 >= sy && near.1 < sy + sh;
    let Some(&(sx, sy, sw, sh)) = screens.iter().find(holds).or(screens.first()) else { return (x, y) };
    (x.min(sx + sw - w).max(sx).round(), y.min(sy + sh - h).max(sy).round())
}

/// Makes a spec's place one the person can see: a size too small to find (0×0) becomes the default,
/// and a place on no screen (Windows parks a minimized window at -32000, an older helper wrote that
/// into specs; a screen that was unplugged) moves to the middle of the first screen. True if changed.
fn fit(spec: &mut Spec, screens: &[Area]) -> bool {
    let d = Spec::default();
    let mut changed = false;
    if !(spec.width.is_finite() && spec.width >= MIN_SIDE) {
        spec.width = d.width;
        changed = true;
    }
    if !(spec.height.is_finite() && spec.height >= MIN_SIDE) {
        spec.height = d.height;
        changed = true;
    }
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        let (w, h) = shown_size(spec);
        // At least a corner big enough to grab is on some screen.
        let seen = |&(sx, sy, sw, sh): &Area| {
            (x + w).min(sx + sw) - x.max(sx) >= w.min(40.0) && (y + h).min(sy + sh) - y.max(sy) >= h.min(MIN_SIDE)
        };
        if !(x.is_finite() && y.is_finite()) || (!screens.is_empty() && !screens.iter().any(seen)) {
            match screens.first() {
                Some(&(sx, sy, sw, sh)) => {
                    spec.x = Some((sx + (sw - w).max(0.0) / 2.0).round());
                    spec.y = Some((sy + (sh - h).max(0.0) / 2.0).round());
                }
                None => (spec.x, spec.y) = (None, None),
            }
            changed = true;
        }
    }
    changed
}

/// The screens, the primary one first.
fn screens(all: impl Iterator<Item = tao::monitor::MonitorHandle>, primary: Option<tao::monitor::MonitorHandle>) -> Vec<Area> {
    let area = |m: &tao::monitor::MonitorHandle| {
        let s = m.scale_factor();
        let (p, z) = (m.position(), m.size());
        (p.x as f64 / s, p.y as f64 / s, z.width as f64 / s, z.height as f64 / s)
    };
    let mut out: Vec<Area> = primary.iter().map(area).collect();
    for m in all {
        let a = area(&m);
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

/// Some window has a `hoverOpacity`: the pointer thread asks for a look every POINTER_POLL.
static WATCH_POINTER: AtomicBool = AtomicBool::new(false);

enum UserEvent {
    /// The windows folder as it is now: id -> spec text. Sent only when something changed.
    Specs(HashMap<String, String>),
    Message(String, String),
    /// From the page to the helper: drag, resize:<n|s|e|w|ne|nw|se|sw>, close, minimize,
    /// collapse[:<width>,<height>], expand.
    Control(String, String),
    /// Time to look where the mouse is (only sent while some window has a `hoverOpacity`).
    Pointer,
    Loaded(String),
    Tick,
    Stop,
}

struct Float {
    id: String,
    spec: Spec,
    window: Window,
    webview: WebView,
    /// Position / size changed by the person; written out once they stop moving.
    moved: Option<Instant>,
    resized: Option<Instant>,
    focused: bool,
    /// The active window overlaps this one (only looked at while `behind_opacity` is set).
    behind: bool,
    /// The mouse is over this window (only looked at while `hover_opacity` is set), and when it
    /// was first seen outside.
    hover: bool,
    hover_left: Option<Instant>,
    /// The opacity the window has now (NaN: not set yet).
    shown: f64,
    warned: bool,
    /// When the spec last asked to minimize / restore: the window's state lags behind for a moment.
    minimize_asked: Option<Instant>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, dir) = match args.as_slice() {
        [c, d] if ["start", "run", "stop"].contains(&c.as_str()) => (c.as_str(), PathBuf::from(d)),
        [v] if v == "--version" || v == "-V" => {
            println!("k-float {VERSION}");
            return;
        }
        _ => {
            eprintln!("usage: k-float start|run|stop <dir>\n       k-float --version");
            std::process::exit(2);
        }
    };
    let result = match cmd {
        "start" => start(&dir),
        "stop" => fs::write(dir.join("stop"), "").map_err(|e| e.to_string()),
        _ => run(&dir),
    };
    if let Err(e) = result {
        eprintln!("k-float: {e}");
        std::process::exit(1);
    }
}

fn prepare(dir: &Path) -> Result<(), String> {
    for sub in ["windows", "events"] {
        fs::create_dir_all(dir.join(sub)).map_err(|e| format!("{}: {e}", dir.join(sub).display()))?;
    }
    Ok(())
}

/// The lock is held for as long as the helper runs; the OS drops it if the helper dies.
fn lock(dir: &Path) -> Result<Option<File>, String> {
    let path = dir.join("helper.lock");
    let file = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // Named in full: newer Rust has its own File::try_lock, older Rust doesn't.
    match fs4::FileExt::try_lock(&file) {
        Ok(()) => Ok(Some(file)),
        Err(_) => Ok(None),
    }
}

/// install.sh writes <dir>/paused while it rebuilds the helper (Windows can't replace a running
/// program): `start` doesn't start one meanwhile. Older than this, it was left behind by a failed run.
const PAUSE_MAX: Duration = Duration::from_secs(15 * 60);

fn start(dir: &Path) -> Result<(), String> {
    prepare(dir)?;
    let paused = fs::metadata(dir.join("paused")).and_then(|m| m.modified()).ok();
    if paused.is_some_and(|t| t.elapsed().map_or(true, |age| age < PAUSE_MAX)) {
        println!("paused");
        return Ok(());
    }
    match lock(dir)? {
        None => {
            println!("running");
            return Ok(());
        }
        Some(file) => drop(file),
    }
    let _ = fs::remove_file(dir.join("stop"));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = std::process::Command::new(exe);
    child.arg("run").arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(match File::create(dir.join("helper.log")) {
            Ok(f) => std::process::Stdio::from(f),
            Err(_) => std::process::Stdio::null(),
        });
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own session: it must outlive the `exec` that started it.
        unsafe {
            child.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A child inherits every inheritable handle, not just the three it is given: holding our
        // stdout would keep whoever ran `start` waiting for its end until the helper exits
        // (Herdr's exec did, 2026-11-24: 30 s, past its own timeout).
        no_inherit();
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Whoever ran `start` (Herdr's exec, hc exec) may end everything in its job when `start`
        // returns: leave the job. Not every job allows that; then start inside it.
        child.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if child.spawn().is_ok() {
            println!("started");
            return Ok(());
        }
        // The job doesn't let go (hc exec, 2026-11-24: a child started here died with `start`).
        // Ask Windows to start it instead (WMI): that process belongs to no one's job, and
        // still opens its windows on this desktop.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let quoted = |p: &Path| p.display().to_string().replace('\'', "''");
        let script = format!(
            // CreateFlags 8 (DETACHED_PROCESS), ShowWindow 0: no console window in front of the person.
            "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{CreateFlags=[uint32]8; ShowWindow=[uint16]0}}; (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='\"{}\" run \"{}\"'; ProcessStartupInformation=$s}}).ReturnValue",
            quoted(&exe),
            quoted(dir)
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("can't start the helper (powershell): {e}"))?;
        let answer = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if answer != "0" {
            return Err(format!("can't start the helper (WMI answered {answer:?}): {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        println!("started");
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        child.spawn().map_err(|e| format!("can't start the helper: {e}"))?;
        println!("started");
        Ok(())
    }
}

/// Keeps this process's stdin, stdout and stderr from being inherited by what it starts.
#[cfg(windows)]
fn no_inherit() {
    use std::os::windows::io::{AsRawHandle, RawHandle};
    const HANDLE_FLAG_INHERIT: u32 = 1;
    extern "system" {
        fn SetHandleInformation(handle: RawHandle, mask: u32, flags: u32) -> i32;
    }
    for handle in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
        if !handle.is_null() {
            // SAFETY: a handle this process owns; a bad one only makes the call fail.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
    }
}

fn run(dir: &Path) -> Result<(), String> {
    prepare(dir)?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let Some(mut lock_file) = lock(&dir)? else {
        return Err("another helper already runs for this folder".into());
    };
    let _ = lock_file.set_len(0);
    let _ = writeln!(lock_file, "{}", json!({ "pid": std::process::id(), "version": VERSION }));
    let _ = fs::remove_file(dir.join("stop"));

    let idle_exit = Duration::from_secs(
        std::env::var("K_FLOAT_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30),
    );

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    {
        let (dir, proxy) = (dir.clone(), proxy.clone());
        std::thread::spawn(move || watch(&dir, proxy));
    }
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(POINTER_POLL);
            if WATCH_POINTER.load(Ordering::Relaxed) && proxy.send_event(UserEvent::Pointer).is_err() {
                return;
            }
        });
    }

    let mut context = WebContext::new(Some(dir.join("webview")));
    let mut floats: HashMap<WindowId, Float> = HashMap::new();
    let mut bad: HashMap<String, String> = HashMap::new();
    let mut empty_since = Instant::now();
    let mut picking = false;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep = &lock_file;
        match event {
            Event::UserEvent(UserEvent::Specs(texts)) => {
                // Gone from the folder: close.
                let gone: Vec<WindowId> = floats.iter().filter(|(_, f)| !texts.contains_key(&f.id)).map(|(w, _)| *w).collect();
                for w in gone {
                    if let Some(f) = floats.remove(&w) {
                        emit(&dir, &f.id, json!({ "type": "closed", "by": "spec" }));
                    }
                }
                bad.retain(|id, _| texts.contains_key(id));
                for (id, text) in texts {
                    let mut spec = match serde_json::from_str::<Spec>(&text) {
                        Ok(spec) => spec,
                        Err(e) => {
                            // A half-written file parses on a later pass; report each bad text once.
                            if bad.get(&id) != Some(&text) {
                                emit(&dir, &id, json!({ "type": "error", "message": format!("spec is not valid: {e}") }));
                                bad.insert(id, text);
                            }
                            continue;
                        }
                    };
                    bad.remove(&id);
                    if let Some(f) = floats.values_mut().find(|f| f.id == id) {
                        let fixed = fit(&mut spec, &screens(f.window.available_monitors(), f.window.primary_monitor()));
                        apply(&dir, f, spec);
                        if fixed {
                            refitted(&dir, f);
                        }
                    } else {
                        let fixed = fit(&mut spec, &screens(target.available_monitors(), target.primary_monitor()));
                        match open(target, &mut context, &proxy, &id, &spec) {
                            Ok(mut f) => {
                                if fixed {
                                    refitted(&dir, &f);
                                }
                                show_opacity(&dir, &mut f, false);
                                if spec.click_through {
                                    click_through(&dir, &f, true);
                                }
                                if spec.minimized {
                                    f.window.set_minimized(true);
                                    f.minimize_asked = Some(Instant::now());
                                }
                                floats.insert(f.window.id(), f);
                            }
                            Err(e) => emit(&dir, &id, json!({ "type": "error", "message": format!("can't open the window: {e}") })),
                        }
                    }
                }
                WATCH_POINTER.store(floats.values().any(|f| f.spec.hover_opacity.is_some()), Ordering::Relaxed);
            }
            Event::UserEvent(UserEvent::Pointer) => {
                for f in floats.values_mut().filter(|f| f.spec.hover_opacity.is_some()) {
                    let minimized = f.window.is_minimized();
                    let over = !minimized && pointer_over(f);
                    if hover_step(&mut f.hover, &mut f.hover_left, over, minimized, Instant::now()) {
                        show_opacity(&dir, f, false);
                    }
                }
            }
            Event::UserEvent(UserEvent::Message(id, body)) => {
                let data = serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body));
                emit(&dir, &id, json!({ "type": "message", "data": data }));
            }
            Event::UserEvent(UserEvent::Control(id, cmd)) => {
                let Some(w) = floats.iter().find(|(_, f)| f.id == id).map(|(w, _)| *w) else { return };
                if cmd == "close" {
                    user_closed(&dir, &mut floats, w);
                    return;
                }
                // The page's picker: done (with what it copied) or left. Either way picking ends everywhere.
                if cmd == "pick-off" || cmd.starts_with("picked:") {
                    if let Some(locator) = cmd.strip_prefix("picked:") {
                        emit(&dir, &id, json!({ "type": "pick", "locator": locator }));
                        let _ = fs::write(dir.join("picked"), locator);
                    }
                    let _ = fs::remove_file(dir.join("pick"));
                    return;
                }
                let Some(f) = floats.get_mut(&w) else { return };
                match cmd.as_str() {
                    "drag" => {
                        let _ = f.window.drag_window();
                    }
                    "minimize" => f.window.set_minimized(true),
                    "expand" => {
                        if f.spec.collapsed {
                            f.spec.collapsed = false;
                            set_collapsed(&dir, f, None, true);
                        }
                    }
                    c if c == "collapse" || c.starts_with("collapse:") => {
                        if let Some((w, h)) = c.strip_prefix("collapse:").and_then(|s| s.split_once(',')) {
                            if let (Ok(w), Ok(h)) = (w.parse::<f64>(), h.parse::<f64>()) {
                                // While collapsed already: the button keeps the size it has.
                                if !f.spec.collapsed {
                                    (f.spec.collapsed_width, f.spec.collapsed_height) = (w, h);
                                }
                            }
                        }
                        if !f.spec.collapsed {
                            f.spec.collapsed = true;
                            set_collapsed(&dir, f, None, true);
                        }
                    }
                    c => {
                        // A collapsed window has no edges to pull.
                        if let Some(d) = c.strip_prefix("resize:").and_then(resize_direction).filter(|_| !f.spec.collapsed) {
                            let _ = f.window.drag_resize_window(d);
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Loaded(id)) => {
                if let Some(f) = floats.values().find(|f| f.id == id) {
                    push_data(f);
                    push_collapsed(f);
                    if picking {
                        push_pick(f, true);
                    }
                    emit(&dir, &id, json!({ "type": "ready" }));
                }
            }
            Event::UserEvent(UserEvent::Stop) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Tick) => {
                // <dir>/pick: k-pick is open in Herdr (or a page asked): every window's page picks too.
                let wanted = pick_wanted(&dir.join("pick"), SystemTime::now());
                if wanted != picking {
                    picking = wanted;
                    for f in floats.values() {
                        push_pick(f, picking);
                    }
                }
                for f in floats.values_mut() {
                    settle(&dir, f);
                    sync_minimized(&dir, f);
                    let behind = f.spec.behind_opacity.is_some() && !f.focused && covered_by_active(f);
                    if behind != f.behind {
                        f.behind = behind;
                        show_opacity(&dir, f, false);
                    }
                }
                if floats.is_empty() {
                    if empty_since.elapsed() >= idle_exit {
                        *control_flow = ControlFlow::Exit;
                    }
                } else {
                    empty_since = Instant::now();
                }
            }
            Event::WindowEvent { window_id, event, .. } => match event {
                WindowEvent::CloseRequested => user_closed(&dir, &mut floats, window_id),
                WindowEvent::Focused(on) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.focused = on;
                        if on {
                            f.behind = false;
                        }
                        show_opacity(&dir, f, false);
                    }
                }
                WindowEvent::Moved(_) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.moved = Some(Instant::now());
                    }
                }
                WindowEvent::Resized(_) => {
                    if let Some(f) = floats.get_mut(&window_id) {
                        f.resized = Some(Instant::now());
                    }
                }
                _ => {}
            },
            _ => {}
        }
    });
}

/// The person closed the window (its × or the page's float.close()).
fn user_closed(dir: &Path, floats: &mut HashMap<WindowId, Float>, w: WindowId) {
    if let Some(f) = floats.remove(&w) {
        // Remove the spec first, so the next pass doesn't reopen it.
        let _ = fs::remove_file(dir.join("windows").join(format!("{}.json", f.id)));
        emit(dir, &f.id, json!({ "type": "closed", "by": "user" }));
    }
}

fn resize_direction(d: &str) -> Option<ResizeDirection> {
    Some(match d {
        "n" => ResizeDirection::North,
        "s" => ResizeDirection::South,
        "e" => ResizeDirection::East,
        "w" => ResizeDirection::West,
        "ne" => ResizeDirection::NorthEast,
        "nw" => ResizeDirection::NorthWest,
        "se" => ResizeDirection::SouthEast,
        "sw" => ResizeDirection::SouthWest,
        _ => return None,
    })
}

/// Polls the windows folder; a handful of small files, so this costs nothing and behaves the same everywhere.
fn watch(dir: &Path, proxy: EventLoopProxy<UserEvent>) {
    let windows = dir.join("windows");
    let mut seen: Option<HashMap<String, (SystemTime, u64)>> = None;
    loop {
        if dir.join("stop").exists() {
            let _ = fs::remove_file(dir.join("stop"));
            let _ = proxy.send_event(UserEvent::Stop);
            return;
        }
        let mut now = HashMap::new();
        if let Ok(entries) = fs::read_dir(&windows) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                if path.extension().and_then(|s| s.to_str()) != Some("json") || !valid_id(id) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    now.insert(id.to_string(), (meta.modified().unwrap_or(UNIX_EPOCH), meta.len()));
                }
            }
        }
        if seen.as_ref() != Some(&now) {
            let mut texts = HashMap::new();
            for id in now.keys() {
                // Unreadable right now (being replaced): an empty text fails to parse and is retried.
                // Windows PowerShell 5 writes UTF-8 with a byte order mark; JSON doesn't allow one.
                let text = fs::read_to_string(windows.join(format!("{id}.json"))).unwrap_or_default();
                texts.insert(id.clone(), text.trim_start_matches('\u{feff}').to_string());
            }
            // An empty or half-written file: look again on the next pass.
            let partial = texts.values().any(|t| serde_json::from_str::<Value>(t).is_err());
            seen = if partial { None } else { Some(now) };
            if proxy.send_event(UserEvent::Specs(texts)).is_err() {
                return;
            }
        }
        if proxy.send_event(UserEvent::Tick).is_err() {
            return;
        }
        std::thread::sleep(POLL);
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn open(
    target: &EventLoopWindowTarget<UserEvent>,
    context: &mut WebContext,
    proxy: &EventLoopProxy<UserEvent>,
    id: &str,
    spec: &Spec,
) -> Result<Float, String> {
    let shown = shown_size(spec);
    let mut builder = WindowBuilder::new()
        .with_title(&spec.title)
        .with_inner_size(LogicalSize::new(shown.0, shown.1))
        .with_always_on_top(spec.topmost)
        .with_decorations(spec.frame)
        .with_focused(false);
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        builder = builder.with_position(LogicalPosition::new(x, y));
    }
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowBuilderExtUnix;
        builder = builder.with_skip_taskbar(!spec.taskbar);
    }
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowBuilderExtWindows;
        builder = builder.with_skip_taskbar(!spec.taskbar);
    }
    let window = builder.build(target).map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (spec.x, spec.y) {
        window.set_outer_position(LogicalPosition::new(x, y));
    }
    if spec.collapsed {
        hold_size(&window, Some(shown));
    }

    let (ipc_id, ipc_proxy) = (id.to_string(), proxy.clone());
    let (load_id, load_proxy) = (id.to_string(), proxy.clone());
    let webview_builder = WebViewBuilder::new_with_web_context(context)
        // A window that appears must not take the keyboard from what the person is typing in.
        .with_focused(false)
        .with_initialization_script(&page_api(id, spec.frame, spec.collapsed))
        .with_html(&spec.html)
        .with_ipc_handler(move |request| {
            let body = request.body();
            let event = match body.strip_prefix('\u{1}') {
                Some(cmd) => UserEvent::Control(ipc_id.clone(), cmd.to_string()),
                None => UserEvent::Message(ipc_id.clone(), body.clone()),
            };
            let _ = ipc_proxy.send_event(event);
        })
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(UserEvent::Loaded(load_id.clone()));
            }
        });
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or("the window has no container")?;
        webview_builder.build_gtk(vbox).map_err(|e| e.to_string())?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview_builder.build(&window).map_err(|e| e.to_string())?;

    Ok(Float {
        id: id.to_string(),
        spec: spec.clone(),
        window,
        webview,
        moved: None,
        resized: None,
        focused: false,
        behind: false,
        hover: false,
        hover_left: None,
        shown: f64::NAN,
        warned: false,
        minimize_asked: None,
    })
}

/// Brings an open window in line with a changed spec.
fn apply(dir: &Path, f: &mut Float, spec: Spec) {
    if spec == f.spec {
        return;
    }
    let old = std::mem::replace(&mut f.spec, spec);
    let spec = &f.spec;
    if spec.title != old.title {
        f.window.set_title(&spec.title);
    }
    let placed = (spec.x, spec.y) != (old.x, old.y);
    let flipped = spec.collapsed != old.collapsed;
    if placed {
        if let (Some(x), Some(y)) = (spec.x, spec.y) {
            f.window.set_outer_position(LogicalPosition::new(x, y));
        }
    }
    if flipped {
        // The spec's place, if this change gave one, is where the window was before the flip.
        let from = if placed { spec.x.zip(spec.y) } else { None };
        set_collapsed(dir, f, from, false);
    } else if f.spec.collapsed {
        // `width` / `height` are for later (expanding); only the button's own size shows now.
        let (was, now) = (collapsed_size(&old), collapsed_size(&f.spec));
        if was != now {
            hold_size(&f.window, Some(now));
            f.window.set_inner_size(LogicalSize::new(now.0, now.1));
            if let Some((x, y)) = position_now(f) {
                let (dx, dy) = anchor_shift(&f.spec.collapse_anchor, was, now);
                f.window.set_outer_position(LogicalPosition::new(x + dx, y + dy));
            }
        }
    } else if (f.spec.width, f.spec.height) != (old.width, old.height) {
        f.window.set_inner_size(LogicalSize::new(f.spec.width, f.spec.height));
    }
    let spec = &f.spec;
    if spec.topmost != old.topmost {
        f.window.set_always_on_top(spec.topmost);
    }
    if spec.frame != old.frame {
        f.window.set_decorations(spec.frame);
        let _ = f.webview.evaluate_script(&format!("window.__floatFrameless = {}", !spec.frame));
    }
    if spec.minimized != old.minimized && spec.minimized != f.window.is_minimized() {
        f.window.set_minimized(spec.minimized);
        f.minimize_asked = Some(Instant::now());
    }
    if spec.click_through != old.click_through {
        click_through(dir, f, spec.click_through);
    }
    if spec.html != old.html {
        // The page reloads; Loaded pushes the data again.
        if let Err(e) = f.webview.load_html(&spec.html) {
            emit(dir, &f.id, json!({ "type": "error", "message": format!("can't load the page: {e}") }));
        }
    } else if spec.data != old.data {
        push_data(f);
    }
    if spec.behind_opacity.is_none() {
        f.behind = false;
    }
    if spec.hover_opacity.is_none() {
        (f.hover, f.hover_left) = (false, None);
    }
    // Last: on Windows the changes above rewrite the window's styles, and the see-through one with them.
    show_opacity(dir, f, cfg!(windows));
}

/// Takes the window's minimized state into the spec (the person minimized or restored it).
fn sync_minimized(dir: &Path, f: &mut Float) {
    if f.minimize_asked.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
        return;
    }
    f.minimize_asked = None;
    let now = f.window.is_minimized();
    if now != f.spec.minimized {
        f.spec.minimized = now;
        emit(dir, &f.id, json!({ "type": if now { "minimized" } else { "restored" } }));
        remember(dir, f);
    }
}

/// The opacity the window should have now: its `hoverOpacity` with the mouse over it, else its
/// `behindOpacity` while the person works in a window it covers, else its `opacity`.
fn wanted_opacity(spec: &Spec, hover: bool, behind: bool) -> f64 {
    let v = match (hover, spec.hover_opacity, behind, spec.behind_opacity) {
        (true, Some(h), _, _) => h,
        (_, _, true, Some(b)) => b,
        _ => spec.opacity,
    };
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 }
}

fn show_opacity(dir: &Path, f: &mut Float, force: bool) {
    let value = wanted_opacity(&f.spec, f.hover, f.behind);
    // A window never made see-through needs nothing (and on Windows stays out of layered mode).
    let unchanged = value == f.shown || (f.shown.is_nan() && value >= 1.0);
    // `force`: on Windows a style change drops the see-through setting; put it back.
    if unchanged && !(force && value < 1.0) {
        return;
    }
    f.shown = value;
    if !opacity(f, value) && value < 1.0 && !f.warned {
        f.warned = true;
        emit(dir, &f.id, json!({ "type": "warning", "message": "opacity is not supported here (the desktop doesn't blend windows): the window is opaque" }));
    }
}

/// One look at the mouse: `over` = it is on the window now. Entering counts at once; leaving only
/// after HOVER_LEAVE outside (at once for a minimized window). True if `hover` changed.
fn hover_step(hover: &mut bool, left: &mut Option<Instant>, over: bool, at_once: bool, now: Instant) -> bool {
    if over {
        *left = None;
        return !std::mem::replace(hover, true);
    }
    if !*hover {
        return false;
    }
    let since = *left.get_or_insert(now);
    if at_once || now.duration_since(since) >= HOVER_LEAVE {
        (*hover, *left) = (false, None);
        return true;
    }
    false
}

/// The mouse is on this window: the window under the mouse is this one (a window in front of it
/// doesn't count). A click-through window is never "under" the mouse, so its rectangle is used.
#[cfg(windows)]
fn pointer_over(f: &Float) -> bool {
    use tao::platform::windows::WindowExtWindows;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    const GA_ROOT: u32 = 2;
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
        fn WindowFromPoint(point: Point) -> isize;
        fn GetAncestor(hwnd: isize, flags: u32) -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
    }
    let me = f.window.hwnd();
    // SAFETY: plain queries; a stale handle only makes them fail.
    unsafe {
        let mut p = Point::default();
        if GetCursorPos(&mut p) == 0 {
            return false;
        }
        if f.spec.click_through {
            let mut m = Rect::default();
            return GetWindowRect(me, &mut m) != 0 && p.x >= m.l && p.x < m.r && p.y >= m.t && p.y < m.b;
        }
        // The webview is a child window (of another process): go up to the top-level one.
        let at = WindowFromPoint(p);
        at != 0 && (at == me || GetAncestor(at, GA_ROOT) == me)
    }
}

#[cfg(target_os = "linux")]
fn pointer_over(f: &Float) -> bool {
    use gtk::gdk::prelude::{DeviceExt, SeatExt};
    use gtk::prelude::WidgetExt;
    use tao::platform::unix::WindowExtUnix;
    let Some(mine) = f.window.gtk_window().window() else { return false };
    let Some(pointer) = mine.display().default_seat().and_then(|s| s.pointer()) else { return false };
    if f.spec.click_through {
        let (_, px, py) = pointer.position();
        let (_, x, y) = mine.origin();
        return px >= x && px < x + mine.width() && py >= y && py < y + mine.height();
    }
    // Answers only for this program's windows: under another program's window it is None.
    pointer.window_at_position().0.is_some_and(|w| w.toplevel() == mine)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn pointer_over(_f: &Float) -> bool {
    false
}

/// Keeps the window at exactly this size (None: free again). While collapsed: nothing can resize
/// the button, and on Windows it may be smaller than the system's smallest window (tao answers
/// WM_GETMINMAXINFO with these instead of SM_CXMINTRACK, about 120 logical pixels wide).
fn hold_size(window: &Window, size: Option<(f64, f64)>) {
    use tao::dpi::PixelUnit;
    use tao::window::WindowSizeConstraints;
    let c = match size {
        Some((w, h)) => WindowSizeConstraints::new(
            Some(PixelUnit::Logical(w.into())),
            Some(PixelUnit::Logical(h.into())),
            Some(PixelUnit::Logical(w.into())),
            Some(PixelUnit::Logical(h.into())),
        ),
        None => WindowSizeConstraints::default(),
    };
    window.set_inner_size_constraints(c);
}

/// Where the window is now (logical pixels), as `settle` remembers it.
fn position_now(f: &Float) -> Option<(f64, f64)> {
    // Linux without a frame: tao's outer position comes from the window manager's frame extents,
    // which for an undecorated window under marco are off by the title bar it doesn't have
    // (every save moved the window 30 px up). Moving it places the content, so read the content.
    let position = if cfg!(target_os = "linux") && !f.spec.frame { f.window.inner_position() } else { f.window.outer_position() };
    let p: LogicalPosition<f64> = position.ok()?.to_logical(f.window.scale_factor());
    Some((p.x.round(), p.y.round()))
}

/// Makes the window what `f.spec.collapsed` says (it just changed): the button's size or the
/// expanded one, with the anchor corner where it was. `from`: the window's place before the change,
/// if not where it is now. `by_user`: the page asked (an event is written; the spec always is).
fn set_collapsed(dir: &Path, f: &mut Float, from: Option<(f64, f64)>, by_user: bool) {
    let on = f.spec.collapsed;
    let (full, small) = ((f.spec.width, f.spec.height), collapsed_size(&f.spec));
    let scale = f.window.scale_factor();
    let actual = |window: &Window| {
        let s: LogicalSize<f64> = window.inner_size().to_logical(scale);
        (s.width.round(), s.height.round())
    };
    let place = from.or_else(|| position_now(f)).or(f.spec.x.zip(f.spec.y));
    let (was, now);
    if on {
        was = full;
        hold_size(&f.window, Some(small));
        f.window.set_inner_size(LogicalSize::new(small.0, small.1));
        // Windows resizes at once, and may not have given the size asked for: anchor what it gave.
        now = if cfg!(windows) { actual(&f.window) } else { small };
    } else {
        was = if cfg!(windows) { actual(&f.window) } else { small };
        hold_size(&f.window, None);
        f.window.set_inner_size(LogicalSize::new(full.0, full.1));
        now = full;
    }
    if let Some((x, y)) = place {
        let (dx, dy) = anchor_shift(&f.spec.collapse_anchor, was, now);
        let mut to = (x + dx, y + dy);
        if !on {
            // Expanding from a button near a screen's edge: all of the window comes onto that screen.
            let screens = screens(f.window.available_monitors(), f.window.primary_monitor());
            to = onto_screen(to, now, (x + was.0 / 2.0, y + was.1 / 2.0), &screens);
        }
        f.window.set_outer_position(LogicalPosition::new(to.0, to.1));
        (f.spec.x, f.spec.y) = (Some(to.0), Some(to.1));
    }
    // The size change is ours, not the person's: nothing for `settle` to write.
    f.resized = None;
    push_collapsed(f);
    // On Windows resizing can rewrite the window's styles, and the see-through one with them.
    show_opacity(dir, f, cfg!(windows));
    if by_user {
        let mut event = json!({ "type": if on { "collapsed" } else { "expanded" }, "width": now.0, "height": now.1 });
        if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
            event["x"] = json!(x);
            event["y"] = json!(y);
        }
        emit(dir, &f.id, event);
    }
    remember(dir, f);
}

fn push_collapsed(f: &Float) {
    let _ = f.webview.evaluate_script(&format!("window.float && window.float.__collapsed({})", f.spec.collapsed));
}

/// The window the person is working in overlaps this one (desktop and taskbar don't count).
#[cfg(windows)]
fn covered_by_active(f: &Float) -> bool {
    use tao::platform::windows::WindowExtWindows;
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn GetClassNameW(hwnd: isize, name: *mut u16, len: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn IsIconic(hwnd: isize) -> i32;
    }
    let me = f.window.hwnd();
    // SAFETY: plain queries about window handles; a stale handle only makes them fail.
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 || fg == me || IsIconic(fg) != 0 {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            return false; // another of our windows
        }
        let mut name = [0u16; 64];
        let n = GetClassNameW(fg, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..n]);
        if ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class.as_str()) {
            return false;
        }
        let (mut a, mut m) = (Rect::default(), Rect::default());
        if GetWindowRect(fg, &mut a) == 0 || GetWindowRect(me, &mut m) == 0 {
            return false;
        }
        a.l < m.r && m.l < a.r && a.t < m.b && m.t < a.b
    }
}

#[cfg(target_os = "linux")]
fn covered_by_active(f: &Float) -> bool {
    use gtk::gdk::{self, WindowTypeHint};
    use gtk::glib::translate::{from_glib_full, ToGlibPtr};
    use gtk::prelude::{GtkWindowExt, WidgetExt};
    use tao::platform::unix::WindowExtUnix;
    let gw = f.window.gtk_window();
    let (Some(mine), Some(screen)) = (gw.window(), GtkWindowExt::screen(gw)) else { return false };
    // Deprecated in GTK 3.22 but still answers on X11 (from _NET_ACTIVE_WINDOW); gtk-rs dropped the wrapper.
    // SAFETY: the screen outlives the call; the result is a new reference (transfer full) or null.
    let active: Option<gdk::Window> = unsafe { from_glib_full(gdk::ffi::gdk_screen_get_active_window(screen.to_glib_none().0)) };
    let Some(active) = active else { return false };
    if active == mine || matches!(active.type_hint(), WindowTypeHint::Desktop | WindowTypeHint::Dock) {
        return false;
    }
    let (a, m) = (active.frame_extents(), mine.frame_extents());
    a.x() < m.x() + m.width() && m.x() < a.x() + a.width() && a.y() < m.y() + m.height() && m.y() < a.y() + a.height()
}

#[cfg(not(any(target_os = "linux", windows)))]
fn covered_by_active(_f: &Float) -> bool {
    false
}

/// The flag k-pick keeps fresh while it is up. One left behind (k-pick gone without a goodbye) is
/// thrown away: the windows must not stay in picking.
const PICK_FRESH: Duration = Duration::from_secs(4);
fn pick_wanted(flag: &Path, now: SystemTime) -> bool {
    let Ok(meta) = fs::metadata(flag) else { return false };
    let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).unwrap_or(Duration::ZERO);
    if age > PICK_FRESH {
        let _ = fs::remove_file(flag);
        return false;
    }
    true
}

fn push_pick(f: &Float, on: bool) {
    let _ = f.webview.evaluate_script(&format!("window.float && window.float.__pick && window.float.__pick({on})"));
}

fn push_data(f: &Float) {
    let _ = f.webview.evaluate_script(&format!("window.float && window.float.__data({})", f.spec.data));
}

/// Makes the whole window (page and frame alike) this see-through. False: the desktop can't.
/// The page can't do this itself with a transparent background: on WebKitGTK 2.52 a page that
/// repaints over a transparent window paints on top of its last frame, and is opaque within seconds.
fn opacity(f: &Float, value: f64) -> bool {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        use tao::platform::unix::WindowExtUnix;
        let window = f.window.gtk_window();
        window.set_opacity(value);
        // On X11 it takes a compositing manager; without one the window just stays opaque.
        window.screen().is_some_and(|s| s.is_composited())
    }
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        const GWL_EXSTYLE: i32 = -20;
        const WS_EX_LAYERED: isize = 0x0008_0000;
        const LWA_ALPHA: u32 = 2;
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
            fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
            fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
        }
        let hwnd = f.window.hwnd();
        // SAFETY: a window this process owns; a bad handle only makes the calls fail.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if style & WS_EX_LAYERED == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
            }
            SetLayeredWindowAttributes(hwnd, 0, (value * 255.0).round() as u8, LWA_ALPHA) != 0
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (f, value);
        false
    }
}

fn click_through(dir: &Path, f: &Float, on: bool) {
    if let Err(e) = f.window.set_ignore_cursor_events(on) {
        emit(dir, &f.id, json!({ "type": "warning", "message": format!("clickThrough is not supported here: {e}") }));
    }
}

/// Once the person stops dragging: say where the window is now, and remember it in the spec.
fn settle(dir: &Path, f: &mut Float) {
    if f.window.is_minimized() {
        // Windows parks a minimized window at -32000: not a place to remember.
        f.moved = None;
        f.resized = None;
        return;
    }
    let scale = f.window.scale_factor();
    let mut changed = false;
    if f.moved.is_some_and(|t| t.elapsed() >= SETTLE) {
        f.moved = None;
        if let Some((x, y)) = position_now(f) {
            if (Some(x), Some(y)) != (f.spec.x, f.spec.y) {
                f.spec.x = Some(x);
                f.spec.y = Some(y);
                emit(dir, &f.id, json!({ "type": "moved", "x": x, "y": y }));
                changed = true;
            }
        }
    }
    if f.spec.collapsed {
        // The button's size is not the window's: `width` / `height` stay the expanded size.
        f.resized = None;
    }
    if f.resized.is_some_and(|t| t.elapsed() >= SETTLE) {
        f.resized = None;
        let s: LogicalSize<f64> = f.window.inner_size().to_logical(scale);
        let (w, h) = (s.width.round(), s.height.round());
        if (w, h) != (f.spec.width, f.spec.height) {
            f.spec.width = w;
            f.spec.height = h;
            emit(dir, &f.id, json!({ "type": "resized", "width": w, "height": h }));
            changed = true;
        }
    }
    if changed {
        remember(dir, f);
    }
}

/// The spec's place was one no one could see and `fit` changed it: write it back and say so, so a
/// mod that keeps the place (in its own storage) takes the new one.
fn refitted(dir: &Path, f: &Float) {
    if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
        emit(dir, &f.id, json!({ "type": "moved", "x": x, "y": y }));
    }
    emit(dir, &f.id, json!({ "type": "resized", "width": f.spec.width, "height": f.spec.height }));
    remember(dir, f);
}

/// Writes the window's place back into its spec file, keeping every other field as written.
fn remember(dir: &Path, f: &Float) {
    let path = dir.join("windows").join(format!("{}.json", f.id));
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(Value::Object(mut spec)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return };
    if let (Some(x), Some(y)) = (f.spec.x, f.spec.y) {
        spec.insert("x".into(), json!(x));
        spec.insert("y".into(), json!(y));
    }
    spec.insert("width".into(), json!(f.spec.width));
    spec.insert("height".into(), json!(f.spec.height));
    if f.spec.minimized || spec.contains_key("minimized") {
        spec.insert("minimized".into(), json!(f.spec.minimized));
    }
    if f.spec.collapsed || spec.contains_key("collapsed") {
        spec.insert("collapsed".into(), json!(f.spec.collapsed));
    }
    if f.spec.collapsed {
        // The page may have chosen the button's size: a restart must open the same button.
        let (w, h) = collapsed_size(&f.spec);
        spec.insert("collapsedWidth".into(), json!(w));
        spec.insert("collapsedHeight".into(), json!(h));
    }
    let tmp = dir.join("windows").join(format!("{}.json.tmp", f.id));
    if fs::write(&tmp, Value::Object(spec).to_string()).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// Appends one event. `seq` keeps counting across helper restarts; readers remember the last one they handled.
fn emit(dir: &Path, id: &str, mut event: Value) {
    let path = dir.join("events").join(format!("{id}.jsonl"));
    let old = fs::read_to_string(&path).unwrap_or_default();
    let last = old.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()?.get("seq")?.as_u64()).unwrap_or(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    event["seq"] = json!(last + 1);
    event["t"] = json!(t);
    let line = format!("{event}\n");
    if old.len() as u64 > EVENTS_MAX_BYTES {
        // Keep the tail: the file stays under what a mod can read in one go.
        let lines: Vec<&str> = old.lines().collect();
        let tail = lines[lines.len().saturating_sub(EVENTS_KEEP_LINES)..].join("\n");
        let tmp = dir.join("events").join(format!("{id}.jsonl.tmp"));
        if fs::write(&tmp, format!("{tail}\n{line}")).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(x: f64, y: f64, w: f64, h: f64) -> Spec {
        Spec { x: Some(x), y: Some(y), width: w, height: h, ..Spec::default() }
    }
    const SCREENS: [Area; 2] = [(0.0, 0.0, 1536.0, 864.0), (-1920.0, 0.0, 1920.0, 1080.0)];

    #[test]
    fn fit_keeps_a_place_on_a_screen() {
        for s in [spec(94.0, 600.0, 322.0, 34.0), spec(-1800.0, 50.0, 300.0, 200.0), spec(1480.0, 840.0, 300.0, 200.0)] {
            let mut t = s.clone();
            assert!(!fit(&mut t, &SCREENS), "{s:?}");
            assert_eq!(t, s);
        }
    }

    #[test]
    fn fit_brings_back_a_parked_window() {
        // Seen on the laptop: what an older helper wrote while the window was minimized (125%),
        // then Windows' smallest width for it.
        for (w, h) in [(0.0, 0.0), (120.0, 0.0)] {
            let mut t = spec(-25600.0, -25600.0, w, h);
            assert!(fit(&mut t, &SCREENS));
            assert!(t.width >= MIN_SIDE && t.height >= MIN_SIDE, "{t:?}");
            let (x, y) = (t.x.unwrap(), t.y.unwrap());
            assert!(x >= 0.0 && x + t.width <= 1536.0 && y >= 0.0 && y + t.height <= 864.0, "{t:?}");
        }
        let mut t = spec(-32000.0, -32000.0, 300.0, 200.0);
        assert!(fit(&mut t, &SCREENS));
        assert_eq!((t.x, t.y, t.width, t.height), (Some(618.0), Some(332.0), 300.0, 200.0));
    }

    #[test]
    fn fit_without_screens_only_fixes_the_size() {
        let mut t = spec(-25600.0, -25600.0, 0.0, 0.0);
        assert!(fit(&mut t, &[]));
        assert_eq!((t.x, t.y, t.width, t.height), (Some(-25600.0), Some(-25600.0), 320.0, 240.0));
        let mut t = Spec::default();
        assert!(!fit(&mut t, &SCREENS)); // no place: the system picks one
    }

    #[test]
    fn spec_without_the_new_fields_is_as_before() {
        let s: Spec = serde_json::from_str(r#"{"width":300,"height":200,"behindOpacity":0.4}"#).unwrap();
        assert_eq!((s.hover_opacity, s.collapsed, s.collapse_anchor.as_str()), (None, false, "top-right"));
        assert_eq!(shown_size(&s), (300.0, 200.0));
        let s: Spec = serde_json::from_str(r#"{"width":300,"height":200,"hoverOpacity":1,"collapsed":true,"collapsedWidth":40,"collapsedHeight":36,"collapseAnchor":"bottom-left"}"#).unwrap();
        assert_eq!((s.hover_opacity, s.collapsed, s.collapse_anchor.as_str()), (Some(1.0), true, "bottom-left"));
        // Collapsed: the window is the button, `width` / `height` are still the expanded size.
        assert_eq!((shown_size(&s), s.width, s.height), ((40.0, 36.0), 300.0, 200.0));
    }

    #[test]
    fn opacity_order_is_hover_then_behind_then_plain() {
        let s = Spec { opacity: 0.9, behind_opacity: Some(0.3), hover_opacity: Some(1.0), ..Spec::default() };
        assert_eq!(wanted_opacity(&s, false, false), 0.9);
        assert_eq!(wanted_opacity(&s, false, true), 0.3);
        assert_eq!(wanted_opacity(&s, true, true), 1.0);
        assert_eq!(wanted_opacity(&s, true, false), 1.0);
        // Without the field the mouse changes nothing.
        let s = Spec { opacity: 0.9, behind_opacity: Some(0.3), ..Spec::default() };
        assert_eq!((wanted_opacity(&s, true, false), wanted_opacity(&s, true, true)), (0.9, 0.3));
        let s = Spec { hover_opacity: Some(7.0), ..Spec::default() };
        assert_eq!(wanted_opacity(&s, true, false), 1.0);
    }

    #[test]
    fn hover_enters_at_once_and_leaves_after_a_moment() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let (mut hover, mut left) = (false, None);
        assert!(!hover_step(&mut hover, &mut left, false, false, ms(0)));
        assert!(hover_step(&mut hover, &mut left, true, false, ms(50)) && hover);
        assert!(!hover_step(&mut hover, &mut left, true, false, ms(100))); // no change, nothing to do
        // Out and back in within the delay: never left.
        assert!(!hover_step(&mut hover, &mut left, false, false, ms(150)));
        assert!(!hover_step(&mut hover, &mut left, true, false, ms(200)) && hover && left.is_none());
        // Out for good.
        assert!(!hover_step(&mut hover, &mut left, false, false, ms(250)));
        assert!(!hover_step(&mut hover, &mut left, false, false, ms(300)) && hover);
        assert!(hover_step(&mut hover, &mut left, false, false, ms(400)) && !hover && left.is_none());
        // Minimized under the mouse: at once.
        assert!(hover_step(&mut hover, &mut left, true, false, ms(500)));
        assert!(hover_step(&mut hover, &mut left, false, true, ms(550)) && !hover);
    }

    #[test]
    fn collapsed_size_has_a_floor() {
        let mut s = Spec::default();
        assert_eq!(collapsed_size(&s), (44.0, 44.0));
        (s.collapsed_width, s.collapsed_height) = (36.4, 0.0);
        assert_eq!(collapsed_size(&s), (36.0, 44.0));
        (s.collapsed_width, s.collapsed_height) = (f64::NAN, -5.0);
        assert_eq!(collapsed_size(&s), (44.0, 44.0));
    }

    #[test]
    fn collapsing_and_expanding_keep_the_anchor_corner() {
        let (full, small) = ((300.0, 200.0), (44.0, 44.0));
        for (anchor, there) in [("top-right", (256.0, 0.0)), ("top-left", (0.0, 0.0)), ("bottom-right", (256.0, 156.0)), ("bottom-left", (0.0, 156.0)), ("nonsense", (256.0, 0.0))] {
            assert_eq!(anchor_shift(anchor, full, small), there, "{anchor}");
            let back = anchor_shift(anchor, small, full);
            assert_eq!((there.0 + back.0, there.1 + back.1), (0.0, 0.0), "{anchor}: expanding undoes collapsing");
        }
    }

    #[test]
    fn expanding_comes_back_onto_the_buttons_screen() {
        let size = (300.0, 200.0);
        // Room enough: stays.
        assert_eq!(onto_screen((500.0, 300.0), size, (700.0, 320.0), &SCREENS), (500.0, 300.0));
        // The button was dragged to the first screen's left edge (anchor top-right: the window would start at -246).
        assert_eq!(onto_screen((-246.0, 10.0), size, (32.0, 32.0), &SCREENS), (0.0, 10.0));
        // ... to its bottom-right corner.
        assert_eq!(onto_screen((1480.0, 830.0), size, (1502.0, 852.0), &SCREENS), (1236.0, 664.0));
        // On the second screen (to the left): onto that one, not the first.
        assert_eq!(onto_screen((-2100.0, 1000.0), size, (-1900.0, 1020.0), &SCREENS), (-1920.0, 880.0));
        // Bigger than the screen: its top-left corner shows.
        assert_eq!(onto_screen((100.0, 100.0), (2000.0, 900.0), (110.0, 110.0), &SCREENS), (0.0, 0.0));
        assert_eq!(onto_screen((5.0, 6.0), size, (0.0, 0.0), &[]), (5.0, 6.0));
    }

    #[test]
    fn fit_looks_at_the_button_while_collapsed() {
        // The button sits at the right edge; expanded (300 wide) it would count just the same.
        let mut t = Spec { collapsed: true, ..spec(1490.0, 10.0, 300.0, 200.0) };
        assert!(!fit(&mut t, &SCREENS));
        // A button on no screen comes to the middle; the expanded size is untouched.
        let mut t = Spec { collapsed: true, ..spec(-25600.0, -25600.0, 300.0, 200.0) };
        assert!(fit(&mut t, &SCREENS));
        assert_eq!((t.x, t.y, t.width, t.height), (Some(746.0), Some(410.0), 300.0, 200.0));
    }

    #[test]
    fn a_stale_pick_flag_is_dropped() {
        let dir = std::env::temp_dir().join(format!("k-float-pick-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let flag = dir.join("pick");
        assert!(!pick_wanted(&flag, SystemTime::now()));
        fs::write(&flag, "1").unwrap();
        assert!(pick_wanted(&flag, SystemTime::now()));
        assert!(!pick_wanted(&flag, SystemTime::now() + Duration::from_secs(10)));
        assert!(!flag.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_api_starts_in_the_specs_state() {
        let s = page_api("note", false, true);
        assert!(s.starts_with("window.__floatId = \"note\";\nwindow.__floatFrameless = true;\nwindow.__floatCollapsed = true;\n"));
        for name in ["collapse(size)", "expand()", "onCollapsed(fn)", "data-float-drag-click", "data-float-collapsed", "window.float.__pick", "picked:"] {
            assert!(s.contains(name), "{name}");
        }
    }
}
