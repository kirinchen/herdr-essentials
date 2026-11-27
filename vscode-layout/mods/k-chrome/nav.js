// k-chrome 的來回導覽(像 Eclipse 的 Alt+Left / Alt+Right / Ctrl+Q):看過哪些 session、最後在哪個輸入。
// 純邏輯,不碰 herdr;main.js 把 focused() / terminals() 餵進來,拿回要跳去的那一筆。
// 「session」= 一個 pane(terminal 或 mod pane),key 是 tab + pane。

export const MAX = 50;
// 跳過去要連下幾個指令(換 Space、換 tab、focus pane),中間經過的畫面不算「看過」:等到目標出現,或這麼久還沒到就放棄。
export const SETTLE_MS = 800;

/** focused() → 一筆紀錄;沒有 tab(沒有顯示任何 Space)時是 null。 */
export function entryOf(f) {
  if (!f?.tab) return null;
  const pane = f.pane ?? null, terminal = f.shown ?? f.terminal ?? null;
  return { key: `${f.tab}|${pane ?? terminal ?? ""}`, space: f.space ?? null, tab: f.tab, pane, terminal };
}

export class Nav {
  constructor() {
    this.entries = [];
    this.index = -1;
    this.lastInput = null;
    this.states = null;
    this.jump = null;
  }

  get current() { return this.entries[this.index] ?? null; }

  /** 畫面的 focus 現在在這裡。自己跳過去的不重複記;使用者自己換的,丟掉「往後」那段再記一筆。 */
  visit(entry, now = Date.now()) {
    if (!entry) return;
    if (this.jump) {
      const arrived = entry.key === this.jump.key;
      if (!arrived && now <= this.jump.until) return;
      const record = this.jump.record;
      this.jump = null;
      if (arrived && !record) return;
    }
    if (this.current?.key === entry.key) { this.entries[this.index] = entry; return; }
    this.entries = this.entries.slice(0, this.index + 1).filter((e) => e.key !== entry.key);
    this.entries.push(entry);
    if (this.entries.length > MAX) this.entries = this.entries.slice(-MAX);
    this.index = this.entries.length - 1;
  }

  /** 往回(-1)或往後(+1)一筆;已經關掉的(alive 回 false)直接從紀錄拿掉、再往下找。沒有就回 null。 */
  step(dir, alive = () => true, now = Date.now()) {
    const here = this.current;
    this.entries = this.entries.filter((e) => e === here || alive(e));
    this.index = here ? this.entries.indexOf(here) : -1;
    const target = this.entries[this.index + dir];
    if (!target) return null;
    this.index += dir;
    this.jump = { key: target.key, until: now + SETTLE_MS, record: false };
    return target;
  }

  /** terminals() 的 status:正在看的那個 terminal 剛變成 working(從 idle / done / blocked),就是使用者剛在那裡送出輸入。
   *  core 沒有「按鍵時間」可讀,所以只認得會回報狀態的程式(agent);一般 shell 裡打字不算。 */
  input(terminals, entry) {
    const states = new Map();
    for (const t of terminals ?? []) if (t?.address != null) states.set(t.address, t.status ?? null);
    const before = this.states;
    this.states = states;
    if (!before || !entry?.terminal || !before.has(entry.terminal)) return false;
    if (states.get(entry.terminal) !== "working" || before.get(entry.terminal) === "working") return false;
    this.lastInput = entry;
    return true;
  }

  /** 最後輸入的那個 session;沒有、已經關了、或現在就在那裡 → null。跳過去算一次正常的「看」(會進紀錄)。 */
  toInput(alive = () => true, now = Date.now()) {
    const target = this.lastInput;
    if (!target) return null;
    if (!alive(target)) { this.lastInput = null; return null; }
    if (this.current?.key === target.key) return null;
    this.jump = { key: target.key, until: now + SETTLE_MS, record: true };
    return target;
  }
}
