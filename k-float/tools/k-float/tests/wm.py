#!/usr/bin/env python3
"""What needs a window manager: see-through while the person works in a window under it, opaque with
the focus, no title bar (drag / resize from the page, its own close and minimize), and minimize /
bring back; opaque under the mouse (hoverOpacity), collapse to a button and back. Run by wm.sh, which starts a private Xvfb + marco (compositing on) and sets DISPLAY.

    wm.py <k-float binary> [screenshot-prefix]
"""
import json, os, subprocess, sys, tempfile, time
from Xlib import X, Xatom, display, protocol
from Xlib.ext import xtest

BIN, SHOT = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
d = display.Display()
root = d.screen().root
A = lambda name: d.intern_atom(name)
D = tempfile.mkdtemp()
os.makedirs(f"{D}/windows")
fail = 0


def ok(m): print(f"ok   {m}")


def bad(m):
    global fail
    fail = 1
    print(f"FAIL {m}")


def check(m, cond): ok(m) if cond else bad(m)


def events():
    try:
        return [json.loads(l) for l in open(f"{D}/events/note.jsonl") if l.strip()]
    except FileNotFoundError:
        return []


def types(): return [e["type"] for e in events()]


def spec(): return json.load(open(f"{D}/windows/note.json"))


def write(s):
    json.dump(s, open(f"{D}/windows/note.json.tmp", "w"))
    os.replace(f"{D}/windows/note.json.tmp", f"{D}/windows/note.json")


def wait(cond, secs=4.0):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return cond()


def find(title):
    """The client window with this title (marco reparents it into a frame)."""
    def walk(w):
        try:
            name = w.get_full_property(A("_NET_WM_NAME"), A("UTF8_STRING"))
            if name and name.value.decode() == title:
                return w
            for c in w.query_tree().children:
                r = walk(c)
                if r:
                    return r
        except Exception:
            pass
        return None
    return walk(root)


def opacity(w):
    p = w.get_full_property(A("_NET_WM_WINDOW_OPACITY"), Xatom.CARDINAL)
    return round(p.value[0] / 0xFFFFFFFF, 2) if p else 1.0


def activate(w):
    ev = protocol.event.ClientMessage(window=w, client_type=A("_NET_ACTIVE_WINDOW"),
                                      data=(32, [2, X.CurrentTime, 0, 0, 0]))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.flush()


def active():
    p = root.get_full_property(A("_NET_ACTIVE_WINDOW"), Xatom.WINDOW)
    return p.value[0] if p else 0


def place(w):
    """Client window's top-left on the screen."""
    g = w.translate_coords(root, 0, 0)
    return -g.x, -g.y


def move_resize(w, x, y, width, height):
    w.configure(x=x, y=y, width=width, height=height)
    d.flush()


def mouse(x, y, press=None, release=None):
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    if press:
        xtest.fake_input(d, X.ButtonPress, 1)
    if release:
        xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()


def drag(x0, y0, x1, y1):
    mouse(x0, y0)
    time.sleep(0.3)
    mouse(x0, y0, press=True)
    time.sleep(0.4)
    for i in range(1, 11):
        mouse(x0 + (x1 - x0) * i // 10, y0 + (y1 - y0) * i // 10)
        time.sleep(0.05)
    time.sleep(0.2)
    mouse(x1, y1, release=True)


def shot(name):
    if SHOT:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "900x560",
                        "-i", os.environ["DISPLAY"], "-frames:v", "1", f"{SHOT}-{name}.png"])
        print(f"     shot: {SHOT}-{name}.png")


# A program the note sits on top of.
under = root.create_window(40, 40, 700, 460, 0, d.screen().root_depth, background_pixel=0x3a6ea5)
under.set_wm_name("under")
under.change_property(A("_NET_WM_NAME"), A("UTF8_STRING"), 8, b"under")
under.map()
d.sync()
time.sleep(0.8)

# The note: like k-note (no title bar, see-through while the person works in a window under it).
page = ("<!doctype html><style>html,body{margin:0;height:100%;background:#fff7c2;overflow:hidden}"
        "body{display:flex;flex-direction:column;font:14px sans-serif}"
        "#bar{height:22px;display:flex;justify-content:flex-end;gap:2px;padding:0 4px}"
        "#bar button{width:22px;height:18px;border:0;background:#f1e6a6}"
        "textarea{flex:1;border:0;background:transparent;padding:0 12px}</style>"
        "<div id=bar data-float-drag><button id=min>-</button><button id=x>x</button></div>"
        "<textarea>k-float note</textarea>"
        "<script>min.onclick=()=>float.minimize();x.onclick=()=>float.close()</script>")
if os.environ.get("K_FLOAT_WM_PAGE"):   # e.g. k-note's own page (its buttons sit at the same places)
    page = open(os.environ["K_FLOAT_WM_PAGE"]).read()
write({"title": "wm-note", "x": 200, "y": 150, "width": 280, "height": 200, "html": page,
       "frame": False, "opacity": 1, "behindOpacity": 0.35})
env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "CLAUDECODE")}
env["K_FLOAT_IDLE_SECS"] = "3"
out = subprocess.run([BIN, "start", D], env=env, capture_output=True, text=True).stdout.strip()
check(f"start ({out})", out == "started")
check("ready", wait(lambda: "ready" in types(), 8))
note = None
wait(lambda: find("wm-note") is not None)
note = find("wm-note")
check("window exists", note is not None)
if note is None:
    print(open(f"{D}/helper.log").read() if os.path.exists(f"{D}/helper.log") else "")
    sys.exit(1)
time.sleep(0.5)

# 1. No title bar: marco gives the window no frame decoration (its frame is the client's size).
nx, ny = place(note)
g = note.get_geometry()
check(f"no title bar (content at {nx},{ny}, asked 200,150)", abs(ny - 150) <= 2 and abs(nx - 200) <= 2)

# 2. The person works in the window under it: see-through.
activate(under)
check("under is active", wait(lambda: active() == under.id))
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through while the window under it is active ({opacity(note)})", r)
shot("behind")

# 3. The active window moves away from the note: opaque again.
move_resize(under, 600, 500, 250, 120)
r = wait(lambda: opacity(note) == 1.0)
check(f"opaque once the active window doesn't overlap ({opacity(note)})", r)
move_resize(under, 40, 40, 700, 460)
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through again when it overlaps ({opacity(note)})", r)

# 4. The note gets the focus: opaque.
mouse(nx + 100, ny + 120, press=True, release=True)   # click into the text
r = wait(lambda: opacity(note) == 1.0)
check(f"opaque with the focus ({opacity(note)})", r)
shot("focused")
# ... and back to see-through when the person goes back to the window under it.
activate(under)
r = wait(lambda: opacity(note) == 0.35)
check(f"see-through again after leaving it ({opacity(note)})", r)

# 5. Drag the strip: the window moves and the spec remembers it.
drag(nx + 60, ny + 10, nx + 160, ny + 70)
check("moved by dragging the strip", wait(lambda: sum(t == "moved" for t in types()) >= 1 and abs(spec().get("x", 0) - 300) <= 3))
s = spec()
check(f"spec remembers the place ({s.get('x')},{s.get('y')}; expected 300,210)", abs(s.get("x", 0) - 300) <= 3 and abs(s.get("y", 0) - 210) <= 3)
check(f"the window is where the spec says ({place(note)})", abs(place(note)[0] - s["x"]) <= 3 and abs(place(note)[1] - s["y"]) <= 3)

# 6. Drag the bottom-right corner: resized.
nx, ny = place(note)
g = note.get_geometry()
drag(nx + g.width - 2, ny + g.height - 2, nx + g.width + 58, ny + g.height + 38)
check("resized from the corner", wait(lambda: "resized" in types()))
s = spec()
check(f"spec remembers the size ({s.get('width')}x{s.get('height')})", abs(s.get("width", 0) - 340) <= 4 and abs(s.get("height", 0) - 240) <= 4)

# 7. The page's minimize button; then bring it back from the spec.
nx, ny = place(note)
g = note.get_geometry()
mouse(nx + g.width - 40, ny + 10, press=True, release=True)   # "-" (left of "x")
check("minimized by the page's button", wait(lambda: "minimized" in types()))
check("spec says minimized", wait(lambda: spec().get("minimized") is True))
check("window is hidden", note.get_attributes().map_state != X.IsViewable)
s = spec(); s["minimized"] = False; write(s)
check("restored by the spec", wait(lambda: "restored" in types() or note.get_attributes().map_state == X.IsViewable))
check("window is shown again", wait(lambda: note.get_attributes().map_state == X.IsViewable))
time.sleep(2.5)   # past the grace period: the helper must not take the old state back
check("stays shown", note.get_attributes().map_state == X.IsViewable and spec().get("minimized") is False)
shot("restored")

# Close and reopen from the remembered spec: same place (no drift).
before = place(note)
s = spec()
os.remove(f"{D}/windows/note.json")
wait(lambda: find("wm-note") is None)
write(s)
wait(lambda: find("wm-note") is not None)
note = find("wm-note")
time.sleep(1.2)
after = place(note)
check(f"reopened at the same place ({before} -> {after})", abs(before[0] - after[0]) <= 2 and abs(before[1] - after[1]) <= 2)
check("spec not moved by reopening", abs(spec()["x"] - s["x"]) <= 2 and abs(spec()["y"] - s["y"]) <= 2)

# 8. The page's close button: closed by user, spec removed.
nx, ny = place(note)
g = note.get_geometry()
mouse(nx + g.width - 16, ny + 10, press=True, release=True)
check("closed by the page's button", wait(lambda: any(e["type"] == "closed" and e.get("by") == "user" for e in events())))
check("spec removed", not os.path.exists(f"{D}/windows/note.json"))
check("no warning", "warning" not in types())

# 9. A spec with the place Windows gives a minimized window (written by an older helper, seen on the
#    laptop): opened where it can be seen, and the spec says so.
json.dump({"title": "wm-parked", "x": -25600, "y": -25600, "width": 120, "height": 0, "html": "<body style=background:#cde>parked"},
          open(f"{D}/windows/parked.json", "w"))
wait(lambda: find("wm-parked") is not None)
parked = find("wm-parked")
check("parked spec opens a window", parked is not None)
if parked:
    time.sleep(0.8)
    px, py = place(parked)
    pg = parked.get_geometry()
    check(f"on the screen ({px},{py} {pg.width}x{pg.height})", 0 <= px and px + pg.width <= 1280 and 0 <= py and py + pg.height <= 800 and pg.height >= 20)
    p = json.load(open(f"{D}/windows/parked.json"))
    check(f"spec rewritten ({p.get('x')},{p.get('y')} {p.get('width')}x{p.get('height')})", p["x"] >= 0 and p["y"] >= 0 and p["height"] >= 20)
    pe = [json.loads(l) for l in open(f"{D}/events/parked.jsonl") if l.strip()]
    check("moved event with the new place", any(e["type"] == "moved" and e["x"] >= 0 for e in pe))
os.remove(f"{D}/windows/parked.json")

# 10. hoverOpacity and collapse-to-a-button (what kirin-inbox uses). A second window, "box":
#     see-through, opaque under the mouse; its "c" button collapses it to 44x44, the button expands it.
def bev():
    try:
        return [json.loads(l) for l in open(f"{D}/events/box.jsonl") if l.strip()]
    except FileNotFoundError:
        return []


def btypes(): return [e["type"] for e in bev()]


def bspec(): return json.load(open(f"{D}/windows/box.json"))


def bwrite(s):
    json.dump(s, open(f"{D}/windows/box.json.tmp", "w"))
    os.replace(f"{D}/windows/box.json.tmp", f"{D}/windows/box.json")


def said(v): return sum(1 for e in bev() if e["type"] == "message" and e["data"] == {"collapsed": v})


def rect(w):
    x, y = place(w)
    g = w.get_geometry()
    return x, y, g.width, g.height


def near(a, b, tol=3): return all(abs(p - q) <= tol for p, q in zip(a, b))


def see(m, want, secs=2.0):
    """The box's opacity becomes `want` (the message shows what it was in the end)."""
    r = wait(lambda: opacity(box) == want, secs)
    check(f"{m} ({opacity(box)}, expected {want})", r)


box_page = ("<!doctype html><style>html,body{margin:0;height:100%;background:#dff3e4;overflow:hidden;font:13px sans-serif}"
            "#bar{height:24px;background:#9ccfa8}#btn{display:none;width:100%;height:100%;border:0;background:#c0392b;color:#fff}"
            "html[data-float-collapsed] #full{display:none}html[data-float-collapsed] #btn{display:block}</style>"
            "<div id=full><div id=bar data-float-drag><button id=c>c</button></div>inbox</div>"
            "<button id=btn data-float-drag-click>3</button>"
            "<script>c.onclick=()=>float.collapse({width:44,height:44});btn.onclick=()=>float.expand();"
            "float.onCollapsed(v=>float.send({collapsed:v}))</script>")
AWAY = (1100, 720)
mouse(*AWAY)
move_resize(under, 40, 40, 700, 460)
bwrite({"title": "wm-box", "x": 300, "y": 200, "width": 320, "height": 220, "html": box_page, "frame": False,
        "opacity": 0.8, "behindOpacity": 0.35, "hoverOpacity": 1})
subprocess.run([BIN, "start", D], env=env, capture_output=True)   # no-op if the helper is still there
check("box: ready", wait(lambda: "ready" in btypes(), 8))
wait(lambda: find("wm-box") is not None)
box = find("wm-box")
check("box: window exists", box is not None)
if box is None:
    print(open(f"{D}/helper.log").read() if os.path.exists(f"{D}/helper.log") else "")
    sys.exit(1)
check(f"box: page told it is expanded ({said(False)}x)", wait(lambda: said(False) == 1))
activate(under)
wait(lambda: active() == under.id)
see("hover: mouse away, working in the window under it: behindOpacity", 0.35, 4)
quiet = len(bev())

# The mouse comes over it; the box doesn't get the focus.
mouse(460, 330)
see("hover: mouse over it -> hoverOpacity", 1.0)
check("hover: ... without the focus (the window under it is still the active one)", active() == under.id)
shot("hover")
mouse(*AWAY)
see("hover: mouse left -> back to behindOpacity", 0.35)
# The active window moves away: plain opacity when not hovered, hoverOpacity when hovered.
move_resize(under, 900, 560, 250, 120)
see("hover: not behind, mouse away -> opacity", 0.8, 4)
mouse(460, 330)
see("hover: not behind, mouse over -> hoverOpacity", 1.0, 2)
# Out and straight back in: stays as it is (no flicker).
seen = set()
mouse(*AWAY); time.sleep(0.06); mouse(460, 330)
end = time.time() + 0.6
while time.time() < end:
    seen.add(opacity(box)); time.sleep(0.02)
check(f"hover: out and back in at once doesn't flicker (opacities seen: {sorted(seen)})", seen == {1.0})
# Crossing it many times: no events, no reload.
for i in range(12):
    mouse(*(AWAY if i % 2 else (460, 330))); time.sleep(0.12)
mouse(*AWAY)
see("hover: mouse left again", 0.8, 2)
check(f"hover: no events written, page not reloaded ({len(bev()) - quiet} new)", len(bev()) == quiet and btypes().count("ready") == 1)

# Collapse from the page: 44x44 at the window's top-right corner; width / height in the spec stay.
mouse(312, 212, press=True, release=True)   # "c"
check("collapse: collapsed event", wait(lambda: "collapsed" in btypes()))
r = wait(lambda: near(rect(box), (576, 200, 44, 44)))
check(f"collapse: 44x44 at the old top-right corner ({rect(box)}; expected 576,200 44x44)", r)
time.sleep(1.2)   # past settle: a resize of ours must not be taken for the person's
s = bspec()
check(f"collapse: spec collapsed, expanded size kept ({s.get('collapsed')}, {s.get('width')}x{s.get('height')}, at {s.get('x')},{s.get('y')})",
      s.get("collapsed") is True and (s["width"], s["height"]) == (320, 220) and near((s["x"], s["y"]), (576, 200)))
check("collapse: no resized event", "resized" not in btypes())
check(f"collapse: page told ({said(True)}x)", said(True) == 1)
see("collapse: mouse is where the window was, not on the button: not hovered", 0.8, 2)
shot("collapsed")
mouse(598, 222)
see("collapse: mouse on the button -> hoverOpacity", 1.0, 2)

# Drag the button from its corner: it moves (no resize, no click).
# (The window starts to follow once the mouse has gone 4 px: it ends up to one step, 6,5 here, short.)
drag(617, 241, 677, 291)
r = wait(lambda: near(rect(box), (633, 247, 44, 44), 4))
check(f"button: dragging moves it ({rect(box)}; expected about 636,250 44x44)", r)
BX, BY = place(box)
check("button: moved event, spec has the new place", wait(lambda: "moved" in btypes() and near((bspec()["x"], bspec()["y"]), (BX, BY))))
time.sleep(0.8)
s = bspec()
check(f"button: the drag was not a click, and no edge resized it ({s.get('collapsed')}, {s['width']}x{s['height']}, {btypes().count('expanded')} expanded, {btypes().count('resized')} resized)",
      s.get("collapsed") is True and (s["width"], s["height"]) == (320, 220) and "expanded" not in btypes() and "resized" not in btypes())

# The helper restarts: still a button, at the same place, and the page knows.
subprocess.run([BIN, "stop", D], env=env)
check("restart: window gone with the helper", wait(lambda: find("wm-box") is None))
time.sleep(0.6)
out = subprocess.run([BIN, "start", D], env=env, capture_output=True, text=True).stdout.strip()
check(f"restart: started ({out})", out == "started")
wait(lambda: find("wm-box") is not None, 8)
box = find("wm-box")
check("restart: window is back", box is not None)
if box is None:
    sys.exit(1)
r = wait(lambda: near(rect(box), (BX, BY, 44, 44)))
check(f"restart: still the button at its place ({rect(box)}; expected {BX},{BY} 44x44)", r)
r = wait(lambda: said(True) == 2)
check(f"restart: page told it is collapsed (told {said(True)}x in all)", r)
time.sleep(1.2)
s = bspec()
check(f"restart: spec unchanged ({s.get('collapsed')}, {s['width']}x{s['height']}, at {s['x']},{s['y']})",
      s.get("collapsed") is True and (s["width"], s["height"]) == (320, 220) and near((s["x"], s["y"]), (BX, BY)))

# A click on the button (no movement): expands to the size it had, top-right corner at the button's.
mouse(BX + 22, BY + 22)
time.sleep(0.3)
mouse(BX + 22, BY + 22, press=True)
time.sleep(0.15)
mouse(BX + 24, BY + 23, release=True)   # a hand is never quite still: under the 4 px it is a click
check("expand: expanded event after a click", wait(lambda: "expanded" in btypes()))
EX = BX + 44 - 320
r = wait(lambda: near(rect(box), (EX, BY, 320, 220)))
check(f"expand: the size it had, from the button's corner ({rect(box)}; expected {EX},{BY} 320x220)", r)
time.sleep(1.2)
s = bspec()
check(f"expand: spec ({s.get('collapsed')}, {s['width']}x{s['height']}, at {s['x']},{s['y']})",
      s.get("collapsed") is False and (s["width"], s["height"]) == (320, 220) and near((s["x"], s["y"]), (EX, BY)))
check("expand: no resized event", "resized" not in btypes())
shot("expanded")
# Expanded again: the edge resizes as before.
drag(EX + 318, BY + 218, EX + 358, BY + 248)
check("expand: the corner resizes again", wait(lambda: "resized" in btypes()))
check(f"expand: spec has the new size ({bspec()['width']}x{bspec()['height']})", wait(lambda: near((bspec()["width"], bspec()["height"]), (360, 250), 4)))

# From the spec (a mod): collapse at the bottom-left corner; no event for what the spec asked.
n = btypes().count("collapsed")
s = bspec(); W, H = s["width"], s["height"]
s.update(collapsed=True, collapseAnchor="bottom-left", collapsedWidth=40, collapsedHeight=36); bwrite(s)
r = wait(lambda: near(rect(box), (EX, BY + H - 36, 40, 36)))
check(f"spec: collapsed to 40x36 at the bottom-left corner ({rect(box)}; expected {EX},{BY + H - 36})", r)
check("spec: page told", wait(lambda: said(True) == 3))
time.sleep(1.0)
s = bspec()
check(f"spec: no collapsed event, expanded size kept ({s['width']}x{s['height']})", btypes().count("collapsed") == n and (s["width"], s["height"]) == (W, H))
# Hovered, then minimized, then shown again with the mouse elsewhere: not stuck on hoverOpacity.
bx, by, _, _ = rect(box)
mouse(bx + 20, by + 18)
see("minimize: hovered first", 1.0, 2)
s = bspec(); s["minimized"] = True; bwrite(s)
check("minimize: hidden", wait(lambda: box.get_attributes().map_state != X.IsViewable))
mouse(*AWAY)
s = bspec(); s["minimized"] = False; bwrite(s)
check("minimize: shown again", wait(lambda: box.get_attributes().map_state == X.IsViewable))
see("minimize: not stuck hovered", 0.8, 3)
# Drag the button to the screen's bottom-left and expand from the spec, top-right corner fixed: the
# window would reach off the left and the bottom; all of it comes onto the screen.
bx, by, _, _ = rect(box)
drag(bx + 20, by + 18, bx + 20 - 350, 790)
check("spec: button dragged to the bottom-left of the screen", wait(lambda: place(box)[1] > 700 and place(box)[0] < 60))
time.sleep(1.0)
s = bspec()
check(f"spec: still collapsed after the drag (at {s['x']},{s['y']})", s.get("collapsed") is True)
n = btypes().count("expanded")
off = (s["x"] + 40 - W, s["y"])
s.update(collapsed=False, collapseAnchor="top-right"); bwrite(s)
r = wait(lambda: near(rect(box)[2:], (W, H), 4))
check(f"spec: expanded to the size it had ({rect(box)[2]}x{rect(box)[3]}; expected {W}x{H})", r)
r = wait(lambda: near(rect(box)[:2], (0, 800 - H)))
x, y, w, h = rect(box)
check(f"spec: brought back onto the screen ({x},{y} {w}x{h} in 1280x800; unclamped it would be at {off[0]},{off[1]})", r)
time.sleep(1.2)
s = bspec()
check(f"spec: spec has the place it ended at ({s['x']},{s['y']}; window {rect(box)[:2]}), no expanded event",
      near((s["x"], s["y"]), rect(box)[:2]) and btypes().count("expanded") == n)
check("box: no warning, no error", "warning" not in btypes() and "error" not in btypes())
if fail:
    print("--- box events"); print("\n".join(json.dumps(e) for e in bev()))
os.remove(f"{D}/windows/box.json")

# 11. While install.sh rebuilds the helper (paused), start doesn't start one.
subprocess.run([BIN, "stop", D], env=env)
wait(lambda: find("wm-parked") is None and find("wm-note") is None)
time.sleep(1)
open(f"{D}/paused", "w").close()
out = subprocess.run([BIN, "start", D], env=env, capture_output=True, text=True).stdout.strip()
check(f"paused: not started ({out})", out == "paused")
os.remove(f"{D}/paused")
out = subprocess.run([BIN, "start", D], env=env, capture_output=True, text=True).stdout.strip()
check(f"unpaused: started ({out})", out == "started")
subprocess.run([BIN, "stop", D], env=env)
if fail:
    print("--- events"); print("\n".join(json.dumps(e) for e in events()))
    print("--- log"); print(open(f"{D}/helper.log").read() if os.path.exists(f"{D}/helper.log") else "")
sys.exit(fail)
