// The tool dock's DOM face: one state value projected onto the dock's markup, and the
// events that move between states. The pairing matches freshness.ts / freshnessView.ts —
// toolDock.ts knows what the tools ARE, this knows what the dock DOES with them.
//
// [LAW:decomposition] One sentence, no "and": this module drives the dock's markup from
// one state value. It never touches what any tool DOES (each tool keeps its own script
// and its own network edge on the page), and it knows nothing of the paste page around
// it — the minimap, the turn cards, the version trail are, to this module, simply "the
// regions outside the dock".
//
// It lived inline in a <script> on [slug].astro through PR #112, where five review rounds
// found four real bugs in it — a permanently-latched hidden dock, focus dropped to <body>
// on every panel close, an unrelated resize loop driving the render, and a page left
// tabbable under the scrim. Every one was caught by a hand-driven browser session and by
// nothing else. It is a module so that scripts/tool-dock-view-check.ts can drive it under
// jsdom and those four behaviours have something standing in front of them
// [LAW:verifiable-goals].

import { isAvailable, parseAvailability } from "./toolDock";

// [LAW:one-source-of-truth] The class names that link this module to the dock's markup,
// stated once. The markup is authored in [slug].astro and the selectors are read here, so
// the two ends can drift — scripts/tool-dock-check.ts asserts every token below actually
// appears in that markup, which is the only check able to hold the halves together.
export const DOCK_SELECTORS = {
  dock: "tool-dock",
  launcher: "tool-dock-launcher",
  scrim: "tool-dock-scrim",
  menu: "tool-dock-menu",
  panelHost: "tool-dock-panels",
  item: "tool-dock-item",
  panel: "tool-panel",
} as const;

// Written BY this module rather than authored in the markup, so they are not part of the
// scraped contract above: the body class that hands the dock its floating form, and the
// class marking the item whose panel is open.
export const DOCK_READY_CLASS = "tool-dock-ready";
export const DOCK_ITEM_ACTIVE_CLASS = "is-active";

// [LAW:types-are-the-program] The dock's total state. Three values, and the ones that
// would be contradictions elsewhere — a panel open behind a collapsed bar, a bar expanded
// with two active items — are not expressible here at all, so nothing below has to defend
// against them.
//
// `tool` is a string rather than toolDock.ts's ToolId because the set of tools actually
// on a given page is a DOM fact, not a compile-time one: the page renders only the tools
// its `present` map admits. `resolveDock` is where that string is proved to name a real
// item, and it is proved once [LAW:parse-dont-validate].
export type DockState =
  | { readonly kind: "closed" }
  | { readonly kind: "menu" }
  | { readonly kind: "panel"; readonly tool: string };

// The window the dock lives in, carried rather than reached for as a global. Every DOM
// class this module tests against (`instanceof HTMLElement`) and the MutationObserver it
// installs come off THIS window, so the dock is drivable in any document — including the
// jsdom one its check builds — and reaches for no ambient global at all
// [LAW:no-shared-mutable-globals]. `typeof globalThis` is the half of the type that
// carries those constructors; plain `Window` has only the instance side.
export type DockWindow = Window & typeof globalThis;

// [LAW:parse-dont-validate] The stamp `resolveDock` issues. Everything downstream takes a
// ResolvedDock, a type that cannot exist until the markup has been found and the item↔panel
// pairing proved a bijection — so no function below asks either question a second time, and
// none of them can be handed a half-built dock.
//
// What it holds is deliberately only what CANNOT change while the page lives: the regions
// themselves, and the gate classes the items declare. Anything the page can still alter
// underneath the dock — which capabilities have arrived, which regions exist outside it —
// is re-read at render time instead, because every bug this module has ever had came from
// sampling one of those once [LAW:no-ambient-temporal-coupling].
export interface ResolvedDock {
  readonly win: DockWindow;
  readonly root: HTMLElement;
  readonly launcher: HTMLButtonElement;
  readonly scrim: HTMLElement;
  readonly menu: HTMLElement;
  readonly panelHost: HTMLElement;
  readonly items: readonly HTMLButtonElement[];
  readonly panels: readonly HTMLElement[];
  readonly itemOf: ReadonlyMap<string, HTMLButtonElement>;
  readonly panelOf: ReadonlyMap<string, HTMLElement>;
  // The body classes any item's availability is gated on, deduplicated. The observer below
  // level-triggers on the membership of THIS set rather than on writes to body's class
  // attribute, and it is read off the items' own data-requires — the same attribute
  // `render` consults — so the gate cannot drift from what availability actually reads
  // [LAW:one-source-of-truth].
  readonly gateClasses: readonly string[];
}

// [LAW:parse-dont-validate] A tool id arrives here as a bare attribute string, so it gets
// read through one checkpoint that fails loudly rather than N call sites each defending
// with `?? ""` — which would quietly pair every unlabelled element with every other one
// under the empty-string key [LAW:no-silent-failure].
const toolIdOf = (el: HTMLElement): string => {
  const id = el.dataset.tool;
  if (id === undefined) throw new Error("tool dock element carries no data-tool");
  return id;
};

// What `resolveDock` needs of the thing it is handed: somewhere to run a selector. Stated
// structurally rather than as `ParentNode`, and not only for narrowness — inside `src` the
// Cloudflare Worker types declaration-merge their HTMLRewriter `Element` with the DOM's,
// which gives `ParentNode.append` an incompatible signature and makes a plain HTMLElement
// unassignable to it. Naming the one capability actually used sidesteps the merged member
// entirely, and says something truer about the parameter besides [LAW:types-are-the-program].
export interface DockSource {
  querySelector<E extends Element = Element>(selectors: string): E | null;
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E>;
}

// [LAW:no-defensive-null-guards] The dock and its fixtures are unconditional template
// output on the page that mounts it, so a missing one is a broken template invariant, not
// an optional feature. Each miss throws by name.
const require1 = <T extends Element>(root: DockSource, selector: string, what: string): T => {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`tool dock: no ${what} matching "${selector}"`);
  return el;
};

// Everything the scrim covers: the dock's siblings at each level up to <body>. An open
// panel is drawn over a dimmed page and reads as modal, so it has to BE modal — without
// this a keyboard reader tabs straight out of the panel onto links they cannot see
// underneath the scrim. By construction the dock's own subtree is never in the list: at
// each level we take the siblings of the node we came up through.
//
// [LAW:no-ambient-temporal-coupling] Walked on every render rather than collected once at
// mount, for the same reason availability is re-read rather than sampled: the page's other
// scripts APPEND their regions when they wire up, and the dock cannot know when that is. A
// set captured at mount held only the server-rendered regions — the minimap, which its own
// script appends to <body> afterwards, stayed tabbable underneath the scrim. That is bug 4
// surviving in the one corner a mount-time sample could not see, and it is the same defect
// as the availability latch: a set sampled before the page finished assembling itself.
//
// Reaching the top of the tree without meeting <body> means the dock is not in the document
// at all, which would leave the modal arm silently governing nothing [LAW:no-silent-failure].
const regionsOutside = (win: DockWindow, dock: HTMLElement): readonly HTMLElement[] => {
  const outside: HTMLElement[] = [];
  for (let node: HTMLElement = dock; node !== win.document.body; ) {
    const parent = node.parentElement;
    if (parent === null) throw new Error("tool dock: the dock is not inside document.body");
    for (const sibling of parent.children) {
      if (sibling !== node && sibling instanceof win.HTMLElement) outside.push(sibling);
    }
    node = parent;
  }
  return outside;
};

// [LAW:parse-dont-validate] The one crossing from "some markup" to "a dock". Everything it
// can be wrong about is decided HERE, at mount, where a mismatch is a stack trace — rather
// than three clicks later as a menu item that opens nothing.
export const resolveDock = (root: DockSource): ResolvedDock => {
  const dock = require1<HTMLElement>(root, `.${DOCK_SELECTORS.dock}`, "dock region");
  // The window is what owns the MutationObserver constructor and the document the events
  // are bound to. A dock in a document with no window could be resolved but never driven,
  // so the absence is refused here rather than surfacing as a missing global later.
  const win = dock.ownerDocument.defaultView;
  if (win === null) throw new Error("tool dock: the dock's document has no window");

  const launcher = require1<HTMLButtonElement>(dock, `.${DOCK_SELECTORS.launcher}`, "launcher");
  const scrim = require1<HTMLElement>(dock, `.${DOCK_SELECTORS.scrim}`, "scrim");
  const menu = require1<HTMLElement>(dock, `.${DOCK_SELECTORS.menu}`, "menu");
  const panelHost = require1<HTMLElement>(dock, `.${DOCK_SELECTORS.panelHost}`, "panel host");

  const items = Array.from(dock.querySelectorAll<HTMLButtonElement>(`.${DOCK_SELECTORS.item}`));
  const panels = Array.from(dock.querySelectorAll<HTMLElement>(`.${DOCK_SELECTORS.panel}`));

  // [LAW:one-source-of-truth] The server derives bar items and panels from ONE list
  // (toolDock.ts + the page's `present` map), so they agree by construction — but the link
  // between them is a string once it reaches the DOM, and a string can be wrong. Assert the
  // pairing is a bijection here, where a mismatch is loud.
  const panelOf = new Map(panels.map((panel) => [toolIdOf(panel), panel]));
  const itemOf = new Map(items.map((item) => [toolIdOf(item), item]));
  if (panelOf.size !== panels.length) throw new Error("tool dock: two panels share one data-tool");
  if (itemOf.size !== items.length) throw new Error("tool dock: two menu items share one data-tool");
  if (items.length !== panels.length) {
    throw new Error(`tool dock: ${items.length} menu items for ${panels.length} panels`);
  }
  for (const id of itemOf.keys()) {
    if (!panelOf.has(id)) throw new Error(`tool dock: menu item "${id}" has no panel`);
  }

  const gateClasses = [
    ...new Set(
      items.flatMap((item) => {
        const availability = parseAvailability(item.dataset.requires);
        return availability.kind === "always" ? [] : [...availability.bodyClasses];
      }),
    ),
  ];

  return {
    win,
    root: dock,
    launcher,
    scrim,
    menu,
    panelHost,
    items,
    panels,
    itemOf,
    panelOf,
    gateClasses,
  };
};

// `inert` is written as the CONTENT ATTRIBUTE, not the IDL property. The two are equivalent
// in a browser — the property reflects the attribute — but the attribute is the form that
// is actually observable: it shows up in the DOM, in devtools, and to a check. Assigning
// `.inert` in an environment that does not implement it (jsdom 29 does not) silently
// creates a plain expando that reads back true and governs nothing, which is a state this
// module would then have no way to tell apart from the real one [LAW:no-silent-failure].
const setInert = (el: HTMLElement, inert: boolean): void => {
  el.toggleAttribute("inert", inert);
};

// [LAW:dataflow-not-control-flow] One total projection of the state onto the DOM: every
// attribute is written on every transition, only the values vary, so there is no path where
// a stale aria-expanded survives a change of screen.
//
// [LAW:no-ambient-temporal-coupling] Availability is RE-READ here on every transition
// rather than sampled once at mount. A tool's capability class is added by that tool's own
// script, and script execution order is exactly the kind of incidental timing this dock
// must not depend on — reading it at each render makes "when did the other scripts run" a
// question the dock never has to ask.
export const renderDock = (d: ResolvedDock, s: DockState): void => {
  const body = d.win.document.body;
  const hasBodyClass = (cls: string): boolean => body.classList.contains(cls);

  d.root.dataset.state = s.kind;
  d.launcher.setAttribute("aria-expanded", String(s.kind !== "closed"));
  d.scrim.hidden = s.kind !== "panel";
  // The collapsed menu is CLIPPED, not removed — its items still exist so the pill can
  // interpolate to their width. `inert` is what keeps a clipped item out of the tab order
  // and the a11y tree, so a keyboard reader never lands on a button they cannot see
  // [LAW:one-source-of-truth]: openness is one value, projected onto both the visual state
  // and the focusability.
  setInert(d.menu, s.kind === "closed");

  let available = 0;
  for (const item of d.items) {
    const id = toolIdOf(item);
    const active = s.kind === "panel" && s.tool === id;
    const reachable = isAvailable(parseAvailability(item.dataset.requires), hasBodyClass);
    available += reachable ? 1 : 0;
    item.hidden = !reachable;
    item.classList.toggle(DOCK_ITEM_ACTIVE_CLASS, active);
    item.setAttribute("aria-expanded", String(active));
  }
  for (const panel of d.panels) {
    panel.hidden = !(s.kind === "panel" && s.tool === toolIdOf(panel));
  }
  // A dock with nothing reachable is not a dock — hide the launcher rather than offer an
  // icon that expands into an empty row [LAW:no-silent-failure].
  d.root.hidden = available === 0;
  // The page behind an open panel is inert, matching what the scrim already says visually.
  // Written on every transition like every other attribute here, so there is no path that
  // dims the page without also taking it out of the tab order.
  for (const region of regionsOutside(d.win, d.root)) setInert(region, s.kind === "panel");
};

// [LAW:no-shared-mutable-globals] The dock's state has one owner — the closure `mountDock`
// returns to nobody. Nothing outside this module can write it; the only way in is an event
// on the dock's own markup, which is exactly the set of transitions the state machine
// claims to have.
export const mountDock = (d: ResolvedDock): void => {
  const doc = d.win.document;
  let state: DockState = { kind: "closed" };

  // The item a tool id names, resolved through a loud checkpoint rather than a
  // `?? launcher` at each use — the bijection proved in `resolveDock` already guarantees
  // the item exists, so a miss here is a broken invariant, not a fallback to paper over.
  const itemFor = (id: string): HTMLButtonElement => {
    const item = d.itemOf.get(id);
    if (item === undefined) throw new Error(`tool dock: no menu item for "${id}"`);
    return item;
  };

  // [LAW:dataflow-not-control-flow] Every transition names where focus lands, as a value it
  // carries rather than a courtesy some call sites remember. `renderDock` hides the panel a
  // keyboard reader may be typing in, and a focused element that becomes display:none drops
  // focus to <body> — the reader restarts from the top of the page.
  //
  // Focus is only ours to move when it is INSIDE the dock: that is the one case where
  // `renderDock` can strip it. A reader who clicked out onto the page keeps the caret they
  // just placed, which is why the outside-click path below needs no special casing — focus
  // is by definition elsewhere there, and the same rule leaves it alone.
  const setState = (next: DockState, focusTarget: HTMLElement): void => {
    const active = doc.activeElement;
    const ours = active instanceof d.win.HTMLElement && d.root.contains(active);
    state = next;
    renderDock(d, state);
    if (ours) focusTarget.focus();
  };

  d.launcher.addEventListener("click", () => {
    // The launcher survives every transition it can cause, so it is always a valid landing
    // place for the focus that is already on it.
    setState(state.kind === "closed" ? { kind: "menu" } : { kind: "closed" }, d.launcher);
  });

  for (const item of d.items) {
    item.addEventListener("click", () => {
      const id = toolIdOf(item);
      // A second tap on the active tool folds its panel away and leaves the menu up — the
      // same control, one value flipping [LAW:dataflow-not-control-flow].
      const next: DockState =
        state.kind === "panel" && state.tool === id ? { kind: "menu" } : { kind: "panel", tool: id };
      // Land the caret where the reader is about to type. Panels whose first control is a
      // button (copy, download, check) keep focus on the menu item, so a keyboard reader is
      // never thrown to a control they didn't ask for — and folding a panel away lands
      // there too, since the field is about to be hidden.
      const field =
        next.kind === "panel" ? d.panelOf.get(id)?.querySelector<HTMLElement>("input") : null;
      setState(next, field ?? item);
    });
  }

  // Every anchor inside a panel navigates the page underneath it — an outline entry, a
  // search hit, an archived snapshot — so the dock gets out of the way rather than leaving
  // the reader to dismiss it before they can see where they landed.
  d.panelHost.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof d.win.Element && target.closest("a")) {
      setState({ kind: "closed" }, d.launcher);
    }
  });

  d.scrim.addEventListener("click", () => setState({ kind: "closed" }, d.launcher));

  // Escape unwinds one layer at a time — panel to menu, menu to closed — matching the order
  // the reader opened them in.
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state.kind === "closed") return;
    // Unwinding a panel hands focus back to the item that opened it, not to the launcher —
    // the reader is one Escape from the menu, not out of the dock, so the caret should sit
    // where the next Escape acts.
    setState(
      state.kind === "panel" ? { kind: "menu" } : { kind: "closed" },
      state.kind === "panel" ? itemFor(state.tool) : d.launcher,
    );
  });

  // A click anywhere outside the dock closes it. The scrim already covers this while a
  // panel is open; this arm is what dismisses a bare expanded menu.
  doc.addEventListener("click", (event) => {
    const target = event.target;
    if (state.kind === "closed") return;
    if (target instanceof d.win.Node && d.root.contains(target)) return;
    setState({ kind: "closed" }, d.launcher);
  });

  // Seat the closed state, then hand the dock its floating form. Until this class lands the
  // same markup is a plain block of panels at the foot of the page, so a no-JS reader keeps
  // the ungated tools and never meets a launcher that can't launch.
  renderDock(d, state);
  doc.body.classList.add(DOCK_READY_CLASS);

  // [LAW:no-ambient-temporal-coupling] The capability classes are the dock's real input,
  // and they arrive whenever each tool's own script finishes wiring — an instant this
  // module has no way to know and must not guess at. So availability is level-triggered on
  // that input rather than sampled: a change re-projects the current state. Without this
  // the render above is a one-shot read taken BEFORE the later tool scripts declare, and
  // `root.hidden` latches on it — every path back to `renderDock` runs through the
  // launcher, which the hide has just removed. That door only opens one way, which is what
  // makes a sampled read fatal here and a live one correct. It also keeps an already-open
  // menu honest when a tool declares late.
  //
  // [LAW:parse-dont-validate] The observer fires on every WRITE to body's class attribute,
  // which is a far wider stream than the dock's input: unrelated scripts toggle their own
  // classes there (the minimap rewrites `has-timeline` on every resize tick), and the DOM
  // dirties the attribute even when the token set is unchanged. That raw stream is parsed
  // here into the one fact the dock depends on — the membership of its own gate classes —
  // and `renderDock` runs on a CHANGE of that value, never on the noise around it.
  // Level-triggering on the carrier instead of the fact is what coupled an unrelated
  // animation loop to this render.
  //
  // A REMOVED class counts as a change exactly like an added one: a capability that goes
  // away must un-offer its tool, and keying on additions alone would be a one-way door of
  // the same family as the original latch.
  const gateSignature = (): string =>
    d.gateClasses.map((cls) => String(doc.body.classList.contains(cls))).join(",");
  let gates = gateSignature();
  new d.win.MutationObserver(() => {
    const next = gateSignature();
    if (next === gates) return;
    gates = next;
    renderDock(d, state);
  }).observe(doc.body, { attributes: true, attributeFilter: ["class"] });
};
