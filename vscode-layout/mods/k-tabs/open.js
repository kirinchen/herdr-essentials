// k-tabs 的「開著的 tab」清單(像 VS Code 的編輯器分頁):tab 列列的是你開過的 session,不管在哪個 Space、哪台機器。
// 純邏輯,不碰 herdr。清單是 tab id 的陣列,由左到右。

export const MAX = 100;

/** 現在顯示的 tab 不在清單裡就加進去,放在上一個顯示的右邊(沒有就放最後)。回傳新陣列,沒變就回原本那個。 */
export function opened(open, shown, previous) {
  if (!shown || open.includes(shown)) return open;
  const at = open.indexOf(previous);
  const next = open.slice();
  next.splice(at < 0 ? next.length : at + 1, 0, shown);
  return next;
}

/** 從列上關掉 id 之後該顯示誰:右邊那個,沒有就左邊;列上只剩它 → null。`bar` 是列上看得到的 id。 */
/** Close Other Tabs: the bar's tabs to put away, all but `keep`. Nothing when `keep` isn't on the bar. */
export function others(bar, keep) {
  return bar.includes(keep) ? bar.filter((id) => id !== keep) : [];
}

export function neighbour(bar, id) {
  const at = bar.indexOf(id);
  if (at < 0) return null;
  return bar[at + 1] ?? bar[at - 1] ?? null;
}

/** 把 from 拖到 to 的位置(往右拖放在它後面,往左拖放在它前面)。 */
export function moved(open, from, to) {
  const a = open.indexOf(from), b = open.indexOf(to);
  if (a < 0 || b < 0 || a === b) return open;
  const next = open.slice();
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}

/** 往左(-1)/ 往右(+1)一個,到頭就繞回來。 */
export function cycled(bar, id, dir) {
  if (!bar.length) return null;
  const at = bar.indexOf(id);
  if (at < 0) return bar[0];
  return bar[(at + dir + bar.length) % bar.length];
}

/** 清單太長時,先丟掉已經不存在的 tab(別台機器還沒連上時 tab 會暫時不見,所以平常不丟)。 */
export function trimmed(open, exists, max = MAX) {
  if (open.length <= max) return open;
  const kept = open.filter((id) => exists(id));
  return kept.length > max ? kept.slice(-max) : kept;
}
