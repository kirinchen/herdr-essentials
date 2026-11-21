// k-tabs: the Cards | Terminal switch. Cards (k-chat) take the terminal's place in the
// window: the layout's `{ tab: "active" }` block goes into a stack with a k-chat block,
// put in on the first switch (layout.set, personal layouts only: k-main, not Herdr's main).

export const STACK = "k-chat-stack";
export const CARDS = "k-chat-cards";

const SHIPPED = ["main", "terminals", "win98"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const isTabBlock = (n) => n?.type === "block" && n.content?.tab === "active";
// k-chat docked by itself (an earlier version said place: right): the stack replaces it.
const isLooseChat = (n) => n?.type === "block" && n.content?.mod === "k-chat" && n.id !== CARDS;

// The tree with the tab block in the stack, or null when there's no tab block to put there.
export function withStack(root) {
  let found = false;
  const walk = (n) => {
    if (isTabBlock(n) && !found) {
      found = true;
      const { size, min, max, hidden, ...block } = n;
      const look = block.content?.pane ?? {};
      return {
        id: STACK, type: "stack", active: CARDS,
        ...(size ? { size } : {}), ...(min != null ? { min } : {}), ...(max != null ? { max } : {}), ...(hidden ? { hidden } : {}),
        children: [
          block,
          { id: CARDS, type: "block", content: { mod: "k-chat" }, radius: look.radius ?? 10, border: look.border ?? { width: 1, color: "border" } },
        ],
      };
    }
    if (!Array.isArray(n?.children)) return n;
    return { ...n, children: n.children.filter((c) => !isLooseChat(c)).map(walk) };
  };
  const next = walk(root);
  return found ? next : null;
}

export const canSwitch = (layoutName, root) => !SHIPPED.includes(layoutName) && Boolean(find(root, STACK) || withStack(root));
export const showingCards = (root) => find(root, STACK)?.active === CARDS;

// Shows the cards or the terminal; the first time, puts the stack into the layout.
export function showCards(run, root, on) {
  if (!find(root, STACK)) {
    if (!on) return;
    const next = withStack(root);
    if (!next) return;
    run("layout.set", { layout: next });
  } else {
    const terminal = find(root, STACK).children?.find((c) => c.id !== CARDS)?.id;
    if (on || terminal) run("layout.select", { stack: STACK, child: on ? CARDS : terminal });
  }
  if (on) run("k-chat.focus");
}
