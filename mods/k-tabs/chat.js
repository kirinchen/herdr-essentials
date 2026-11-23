// k-tabs: the Cards | Terminal switch. Cards (k-cards) go above the terminal: the layout's
// `{ tab: "active" }` block goes into a column under a k-cards block and shrinks to a strip
// at the bottom, so Claude Code's own input box, its dialogs and a half-typed message stay
// right there. Terminal hides the cards and gives the terminal the whole height again.
// Written with layout.set: personal layouts only (k-main, not Herdr's main).

export const SPLIT = "k-cards-split";
export const CARDS = "k-cards-cards";
export const BOTTOM = 260; // px: the terminal strip under the cards, about 10 rows
const OLD_STACK = "k-cards-stack"; // the earlier version: cards in a stack, in place of the terminal

const SHIPPED = ["main", "terminals", "win98"];

export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const isTabBlock = (n) => n?.type === "block" && n.content?.tab === "active";
// k-cards docked by itself (an earlier version said place: right): the column replaces it.
const isLooseChat = (n) => n?.type === "block" && n.content?.mod === "k-cards" && n.id !== CARDS;
const sizes = ({ size, min, max, hidden }) => ({ ...(size ? { size } : {}), ...(min != null ? { min } : {}), ...(max != null ? { max } : {}), ...(hidden ? { hidden } : {}) });
const bare = ({ size, min, max, hidden, ...rest }) => rest;

// The terminal's block inside the column, sized for cards shown or hidden.
const terminalBlock = (tab, on) => ({ ...bare(tab), size: on ? { px: BOTTOM } : { weight: 1 }, ...(on ? { min: 120 } : {}) });

function split(tab, outer, on) {
  const look = tab.content?.pane ?? {};
  return {
    id: SPLIT, type: "column", gap: look.gap ?? 8, ...sizes(outer),
    children: [
      { id: CARDS, type: "block", content: { mod: "k-cards" }, size: { weight: 1 }, radius: look.radius ?? 10, border: look.border ?? { width: 1, color: "border" }, ...(on ? {} : { hidden: true }) },
      terminalBlock(tab, on),
    ],
  };
}

// The tree with the cards shown (`on`) or hidden; null when there's no tab block to put them over.
export function withCards(root, on) {
  let found = false;
  const walk = (n) => {
    if (n?.id === SPLIT) {
      found = true;
      return { ...n, children: n.children.map((c) => (c.id === CARDS ? { ...bare(c), size: { weight: 1 }, ...(on ? {} : { hidden: true }) } : isTabBlock(c) ? terminalBlock(c, on) : c)) };
    }
    if (n?.id === OLD_STACK) {
      const tab = n.children?.find(isTabBlock);
      if (tab && !found) { found = true; return split(tab, n, on); }
    }
    if (isTabBlock(n) && !found) { found = true; return split(n, n, on); }
    if (!Array.isArray(n?.children)) return n;
    return { ...n, children: n.children.filter((c) => !isLooseChat(c)).map(walk) };
  };
  const next = walk(root);
  return found ? next : null;
}

// Still the earlier stack: either button puts the column in.
export const outdated = (root) => Boolean(find(root, OLD_STACK));
export const canSwitch = (layoutName, root) => !SHIPPED.includes(layoutName) && Boolean(withCards(root, true));
export function showingCards(root) {
  if (find(root, OLD_STACK)) return find(root, OLD_STACK).active === CARDS;
  const cards = find(root, SPLIT) && find(root, CARDS);
  return Boolean(cards && !cards.hidden);
}

// Shows the cards over the terminal, or the terminal alone.
export function showCards(run, root, on) {
  const next = withCards(root, on);
  if (!next) return;
  run("layout.set", { layout: next });
  // To the latest card.
  if (on) run("k-cards.focus");
}
