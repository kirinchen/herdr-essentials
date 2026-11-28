// k-float (herdr-essentials, ADR 0005): desktop windows for mods. A mod's own overlays are drawn
// inside the Herdr window; these are real system windows, always on top of every other program,
// showing the HTML you give them. A helper program (tools/k-float, one per App home) opens them
// from files, so an agent or a script can do the same without a mod: doc/k-float-protocol.md.
//
//   import { float } from "./float.js";      // copy this file into your mod: a mod imports only from its own folder
//
//   float.listen(cx, "hello", (event, cx) => {            // in init(), before open()
//     if (event.type === "message") float.update("hello", { data: { count: ++this.count } });
//     if (event.type === "closed") …                      // the person closed it (by: "user")
//   });
//   await float.open({ id: "hello", width: 240, height: 120, data: { count: 0 },
//     html: `<button onclick="float.send('add')">+</button> <b id=n></b>
//            <script>float.onData((d) => { n.textContent = d.count; })</script>` });
//   await float.close("hello");
//
// In the page: float.send(value) → a "message" event here; float.onData(fn) ← update(id, { data }).
// Changing `data` doesn't reload the page (what is being typed stays); changing `html` does.
//
// A window that folds into a button (helper 0.2 or newer; it works with the App closed too, the
// helper does it all):
//
//   await float.open({ id: "inbox", frame: false, width: 360, height: 480, opacity: 0.85, hoverOpacity: 1,
//     html: `<style>#btn { display: none } html[data-float-collapsed] #full { display: none }
//                   html[data-float-collapsed] #btn { display: block; width: 100%; height: 100% }</style>
//            <div id=full><div data-float-drag>Inbox <button onclick="float.collapse({ width: 44, height: 44 })">–</button></div>…</div>
//            <button id=btn data-float-drag-click onclick="float.expand()">✉</button>
//            <script>float.onCollapsed((collapsed) => { /* now, and on every change */ })</script>` });
//   await float.collapse("inbox");   await float.expand("inbox");      // the same, from the mod
//
// data-float-drag-click (unlike data-float-drag) also works on a button: moving it 4 px drags the
// window and there is no click; letting go without moving is a click.
// While collapsed the spec's width / height stay the expanded size, and x / y are the button's.
import { exec, appHome, watchFolder, window as appWindow } from "herdr";
import * as fs from "fs/promises";

const root = () => appHome().replace(/[\\/]+$/, "");
/** The folder the helper works from: windows/<id>.json in, events/<id>.jsonl out. */
export const dir = () => `${root()}/data/k-float`;
/** The helper, built by install.sh (cargo build --release in tools/k-float). */
export const helper = () => `${root()}/tools/k-float/target/release/k-float${appWindow()?.platform === "windows" ? ".exe" : ""}`;

const specPath = (id) => `${dir()}/windows/${id}.json`;
const eventsPath = (id) => `${dir()}/events/${id}.jsonl`;

function check(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`k-float: id must be 1-64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(id)})`);
  return id;
}

async function read(path) {
  try { return (await fs.exists(path)) ? await fs.readFile(path, "utf8") : null; } catch { return null; }
}

/** How often listen() makes sure the helper runs while its window is meant to be open. */
const ALIVE_MS = 60000;

// Starts the helper unless it runs already; it leaves by itself 30 seconds after its last window.
async function start() {
  let r;
  try { r = await exec(helper(), ["start", dir()], { timeout: 15000 }); }
  catch (e) { throw new Error(`k-float: the helper isn't installed (${helper()}): run install.sh. ${e?.message ?? e}`); }
  if (r.code !== 0) throw new Error(`k-float: the helper failed to start: ${(r.stderr || r.stdout || "").trim()}`);
}

async function write(id, spec) {
  await fs.mkdir(`${dir()}/windows`, { recursive: true });
  await fs.writeFile(specPath(id), JSON.stringify(spec));
  await start();
}

/** Resolves after `ms` (mods have no setTimeout). */
export const sleep = (cx, ms) => new Promise((done) => { cx.timer.after(ms, () => done()); });

function events(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e?.seq === "number") out.push(e); } catch {} // a line still being written
  }
  return out;
}

export const float = {
  /** Opens a window, or replaces the one with this id.
   *  { id, html, data?, title?, x?, y?, width?, height?, topmost? (true), clickThrough? (false),
   *    opacity? (1: opaque; 0.8 lets a little of what is behind show through),
   *    behindOpacity? (the opacity while the person works in a window this one covers; back to
   *      `opacity` once this one has the focus),
   *    hoverOpacity? (the opacity while the mouse is over the window, focused or not; wins over both),
   *    collapsed? (false; true: shown as a button of collapsedWidth? × collapsedHeight? (44 × 44).
   *      width / height stay the expanded size, x / y are where the window is now, so the button's.
   *      The helper writes it back when the page calls float.collapse() / float.expand()),
   *    collapseAnchor? ("top-right": the corner that stays put; or "top-left", "bottom-right", "bottom-left"),
   *    frame? (true: the system's title bar; without it, elements with data-float-drag move the window,
   *      its outer 6 pixels resize it (not while collapsed), and the page draws its own buttons: float.close(), float.minimize()),
   *    taskbar? (false), minimized? (false; the helper writes it back, set false to bring the window back) };
   *  x, y, width, height in logical pixels. */
  async open(spec) {
    const { id, ...rest } = spec ?? {};
    await write(check(id), rest);
  },

  /** Changes some fields of an open window. False if it isn't open (closed by the person, say). */
  async update(id, patch) {
    let now = null;
    // Someone may be writing the file this instant (the helper, another update): read again
    // rather than take half a file for an empty spec and write the patch alone over the rest.
    for (let tries = 0; now == null; tries++) {
      const text = await read(specPath(check(id)));
      if (text == null) return false;
      try { now = JSON.parse(text); } catch (e) { if (tries >= 8) throw new Error(`k-float: ${id}'s spec can't be read (${e?.message ?? e}); not changed`); }
    }
    const { id: _id, ...rest } = patch ?? {};
    await write(id, { ...now, ...rest });
    return true;
  },

  /** Folds a window into a button ({ width, height }: the button's size, else what the spec has, else
   *  44 × 44) / brings it back to the size it had. False if it isn't open. No "collapsed" / "expanded"
   *  event follows: those are for what the page did. */
  async collapse(id, size) {
    const patch = { collapsed: true };
    if (size?.width > 0 && size?.height > 0) Object.assign(patch, { collapsedWidth: size.width, collapsedHeight: size.height });
    return this.update(id, patch);
  },
  async expand(id) {
    return this.update(id, { collapsed: false });
  },

  /** Closes a window. Fine if it is closed already. */
  async close(id) {
    try { if (await fs.exists(specPath(check(id)))) await fs.unlink(specPath(id)); } catch {}
  },

  /** The window's spec as it is now (the helper keeps x, y, width, height, minimized, collapsed
   *  current), or null if closed. */
  async get(id) {
    const text = await read(specPath(check(id)));
    try { return text == null ? null : JSON.parse(text); } catch { return null; }
  },

  /** Calls handler(event, cx) for what happens to a window from now on:
   *    { type: "ready" }                          its page loaded
   *    { type: "message", data }                  the page called float.send(data)
   *    { type: "moved", x, y } / { type: "resized", width, height }   by the person, once they let go
   *    { type: "closed", by: "user" | "spec" }
   *    { type: "minimized" } / { type: "restored" }
   *    { type: "collapsed" | "expanded", x, y, width, height }   the page called float.collapse() /
   *      float.expand(); the place and size the window has now (no "moved" / "resized" for it)
   *    { type: "error" | "warning", message }
   *  Each also has `seq` and `t` (milliseconds). Runs as a task of `cx`: it ends with the mod copy.
   *  `replay: true` also delivers what is already in the file. */
  listen(cx, id, handler, { replay = false } = {}) {
    check(id);
    return cx.spawn(async (cx) => {
      let last = null;
      let beat = null; // one timer at a time, however many events come in between
      for (;;) {
        const began = Date.now();
        let fresh = [];
        try {
          await fs.mkdir(`${dir()}/events`, { recursive: true }); // someone may have removed the folder
          // Watch first, read second: nothing written between the two is missed.
          const changed = watchFolder(`${dir()}/events`);
          const all = events(await read(eventsPath(id)));
          const end = all.length ? all[all.length - 1].seq : 0;
          if (last == null) last = replay ? 0 : end;
          if (end < last) last = 0; // the file was started over
          fresh = all.filter((e) => e.seq > last);
          if (fresh.length) { last = end; changed.cancel(); }
          else {
            beat ??= sleep(cx, ALIVE_MS).then(() => { beat = null; return "beat"; });
            if ((await Promise.race([changed, beat])) === "beat") {
              changed.cancel();
              // The helper can end while the window is meant to be open (stopped to be rebuilt, a
              // crash): start it again. A no-op while it runs, and while install.sh rebuilds it.
              if (await fs.exists(specPath(id))) await start();
            }
          }
        } catch (err) { console.log(`k-float: ${id} listen: ${err?.message ?? err}`); }
        for (const e of fresh) { try { await handler(e, cx); } catch (err) { console.log(`k-float: ${id} handler: ${err?.message ?? err}`); } }
        if (fresh.length) cx.notify();
        // A watch that can't wait (a missing folder, too many watches) must not become a busy loop.
        else if (Date.now() - began < 100) await sleep(cx, 500);
      }
    });
  },
};

export default float;
