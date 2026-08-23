// The tool dock's state machine, driven under jsdom (slopspot-tool-dock-1mo).
// Run: `tsx scripts/tool-dock-view-check.ts`.
//
// This exists because of a specific history. Across five review rounds on PR #112, FOUR
// real bugs were found in this logic while it lived inline in a <script> on [slug].astro:
//
//   1. a permanently-latched hidden dock (availability sampled once, before the tools'
//      own capability scripts had run — and the hide removed the only path back);
//   2. keyboard focus dropped to <body> whenever a panel closed;
//   3. an unrelated resize loop re-rendering the dock on every tick;
//   4. the page behind an open panel left tabbable underneath the scrim.
//
// Every one was caught by a hand-driven Chrome session, and each fix was then verified
// only by a session nobody will ever re-run. Each numbered bug below has assertions
// standing in front of it now [LAW:verifiable-goals].
//
// [LAW:behavior-not-structure] Nothing here asserts layout, animation, or how the module
// is put together — only what a reader can observe: which region is showing, where the
// caret is, what is reachable by Tab. A completely different implementation of the same
// contract passes. Notably, "the dock did NOT re-render" is asserted by TAMPERING with
// the DOM and watching whether the tamper survives, rather than by counting calls through
// a hook that would exist only for this check.
//
// The page-level facts — which capability classes a script actually adds, which tools
// have panels authored — stay in scripts/tool-dock-check.ts. Those are about the PAGE;
// this file is about the reducer.

import { JSDOM } from "jsdom";
import {
  DOCK_ITEM_ACTIVE_CLASS,
  DOCK_READY_CLASS,
  DOCK_SELECTORS as S,
  mountDock,
  resolveDock,
  type ResolvedDock,
} from "../src/toolDockView";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── The fixture ──────────────────────────────────────────────────────────────
//
// Dock markup in the shape [slug].astro authors it, reduced to what the state machine
// reads: the five regions, one bar item and one panel per tool, and the `data-requires`
// gate. It is deliberately NOT the page's markup — a check that could only run against
// the real page could not construct the situations that matter (every tool gated, a tool
// declaring late, a panel with no text field). What keeps the two in step is the class
// contract: `DOCK_SELECTORS` is imported here rather than retyped, and
// scripts/tool-dock-check.ts asserts every token in it appears in the page's markup, so a
// rename that broke the page could not leave this file passing [LAW:one-source-of-truth].

interface ToolFixture {
  readonly id: string;
  // Absent = the ungated "always" the server writes for a tool needing no capability.
  readonly requires?: string;
  // Panels whose first control is a text field take the caret; panels of buttons do not.
  readonly field?: boolean;
}

const dockMarkup = (tools: readonly ToolFixture[]): string => `
  <div class="${S.dock}" data-state="closed">
    <div class="${S.scrim}" hidden></div>
    <div class="${S.panelHost}">
      ${tools
        .map(
          (t) => `<section class="${S.panel}" data-tool="${t.id}" aria-label="${t.id}">
            ${t.field === true ? `<input type="text" class="${t.id}-field">` : ""}
            <a href="#somewhere" class="${t.id}-link">go</a>
            <button type="button" class="${t.id}-button">do</button>
          </section>`,
        )
        .join("")}
    </div>
    <div class="${S.dock}-bar">
      <button class="${S.launcher}" type="button" aria-expanded="false">Tools</button>
      <div class="${S.menu}">
        <ul>
          ${tools
            .map(
              (t) => `<li><button class="${S.item}" type="button" data-tool="${t.id}"
                ${t.requires === undefined ? "" : `data-requires="${t.requires}"`}
                aria-expanded="false">${t.id}</button></li>`,
            )
            .join("")}
        </ul>
      </div>
    </div>
  </div>`;

// The dock sits one level deep, with siblings at BOTH levels, so the walk that collects
// "everything outside the dock" is exercised rather than trivially satisfied by a dock
// that happens to be a direct child of <body>.
const pageMarkup = (tools: readonly ToolFixture[]): string => `<!DOCTYPE html><html><body>
  <header id="site-header"><a href="#top" id="header-link">home</a></header>
  <main id="page">
    <aside id="minimap"><button id="minimap-button" type="button">rail</button></aside>
    ${dockMarkup(tools)}
  </main>
  <footer id="site-footer"><a href="#colophon" id="footer-link">about</a></footer>
</body></html>`;

interface Harness {
  readonly dom: JSDOM;
  readonly doc: Document;
  readonly body: HTMLElement;
  readonly dock: ResolvedDock;
  readonly item: (id: string) => HTMLButtonElement;
  readonly panel: (id: string) => HTMLElement;
  readonly state: () => string;
  readonly focused: () => string;
  // MutationObserver callbacks are delivered as microtasks (verified against jsdom 29
  // before this file was written, not assumed): one turn of the microtask queue is what
  // separates "the class was written" from "the observer has responded to it".
  // [LAW:no-ambient-temporal-coupling] — an explicit queue turn, never a timer racing it.
  readonly settle: () => Promise<void>;
}

const mount = (tools: readonly ToolFixture[]): Harness => {
  const dom = new JSDOM(pageMarkup(tools));
  const doc = dom.window.document;
  const dock = resolveDock(doc);
  mountDock(dock);
  const find = <T extends HTMLElement>(sel: string, what: string): T => {
    const el = doc.querySelector<T>(sel);
    if (el === null) throw new Error(`fixture is missing its ${what} (${sel})`);
    return el;
  };
  return {
    dom,
    doc,
    body: doc.body,
    dock,
    item: (id) => find<HTMLButtonElement>(`.${S.item}[data-tool="${id}"]`, `${id} bar item`),
    panel: (id) => find<HTMLElement>(`.${S.panel}[data-tool="${id}"]`, `${id} panel`),
    state: () => dock.root.dataset.state ?? "(unset)",
    // The id of whatever holds the caret — a plain string, so a miss reads as the element
    // it actually landed on rather than as `false`. <body> is the failure the focus rule
    // exists to prevent, and it names itself here [LAW:no-silent-failure].
    focused: () => {
      const active = doc.activeElement;
      if (active === null) return "(none)";
      if (active === doc.body) return "body";
      return active.className || active.id || active.tagName.toLowerCase();
    },
    settle: () => Promise.resolve(),
  };
};

const escape = (h: Harness): void => {
  h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
};

const isInert = (el: Element): boolean => el.hasAttribute("inert");

// ── The bijection is proved once, loudly ─────────────────────────────────────

console.log("\nresolveDock refuses markup it cannot drive:");

const refuses = (label: string, html: string): void => {
  const dom = new JSDOM(html);
  let threw = false;
  try {
    resolveDock(dom.window.document);
  } catch {
    threw = true;
  }
  assert(label, threw);
};

refuses(
  "a bar item with no panel",
  `<!DOCTYPE html><body><div class="${S.dock}"><div class="${S.scrim}"></div>
   <div class="${S.panelHost}"></div><div><button class="${S.launcher}"></button>
   <div class="${S.menu}"><button class="${S.item}" data-tool="ghost"></button></div></div></div>`,
);
refuses(
  "two panels claiming one tool id",
  pageMarkup([{ id: "outline" }, { id: "outline" }]),
);
// Duplicating a tool in `pageMarkup` duplicates its item AND its panel, which trips the
// panel check first — so the item check needs markup only IT can reach: two items sharing
// an id, over two distinctly-named panels.
refuses(
  "two menu items claiming one tool id",
  `<!DOCTYPE html><body><div class="${S.dock}"><div class="${S.scrim}"></div>
   <div class="${S.panelHost}"><section class="${S.panel}" data-tool="outline"></section>
   <section class="${S.panel}" data-tool="search"></section></div>
   <div><button class="${S.launcher}"></button><div class="${S.menu}">
   <button class="${S.item}" data-tool="outline"></button>
   <button class="${S.item}" data-tool="outline"></button></div></div></div>`,
);
refuses(
  "an element carrying no data-tool at all",
  `<!DOCTYPE html><body><div class="${S.dock}"><div class="${S.scrim}"></div>
   <div class="${S.panelHost}"><section class="${S.panel}"></section></div>
   <div><button class="${S.launcher}"></button><div class="${S.menu}">
   <button class="${S.item}" data-tool="outline"></button></div></div></div>`,
);
refuses(
  "a dock with no launcher",
  `<!DOCTYPE html><body><div class="${S.dock}"><div class="${S.scrim}"></div>
   <div class="${S.panelHost}"></div><div class="${S.menu}"></div></div>`,
);
refuses("no dock region at all", `<!DOCTYPE html><body><main></main>`);

// Two refusals that replace SILENT behaviour in the inline version this module came from —
// there, a dock outside <body> quietly `break`ed out of the walk and governed nothing. Both
// need their own fixture, or the throws are only claims [LAW:no-silent-failure].
{
  // Refused at MOUNT rather than at resolve, and deliberately so: the walk up to <body> is
  // re-run on every render (a mount-time sample is what let the minimap escape it), so the
  // connectivity check lives in that walk and nowhere else. A second copy inside
  // `resolveDock` would be a duplicate enforcer of one invariant [LAW:single-enforcer]. The
  // contract the assertion states is therefore the true one: a detached dock cannot be
  // DRIVEN, and says so rather than governing nothing.
  const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
  const detached = dom.window.document.createElement("div");
  detached.innerHTML = dockMarkup([{ id: "outline" }]);
  let threw = false;
  try {
    mountDock(resolveDock(detached));
  } catch {
    threw = true;
  }
  assert("a dock in a subtree that never reaches <body> refuses to mount", threw);
}
{
  // A document with no browsing context: resolvable markup, but no window to own the
  // MutationObserver or the constructors `instanceof` is tested against, so it could be
  // resolved and never driven.
  const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
  const orphan = dom.window.document.implementation.createHTMLDocument("orphan");
  orphan.body.innerHTML = dockMarkup([{ id: "outline" }]);
  assert("precondition: that document really has no window", orphan.defaultView === null);
  let threw = false;
  try {
    resolveDock(orphan);
  } catch {
    threw = true;
  }
  assert("a dock in a document with no window", threw);
}

// ── The transition chain ─────────────────────────────────────────────────────

console.log("\nThe dock walks closed → menu → panel → menu → closed:");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.body.classList.add("search-ready");

  assert("mounting seats the closed state", h.state() === "closed");
  assert(`mounting declares the JS face with body.${DOCK_READY_CLASS}`, h.body.classList.contains(DOCK_READY_CLASS));
  assert("closed: the launcher is not expanded", h.dock.launcher.getAttribute("aria-expanded") === "false");
  assert("closed: the menu is inert, so its clipped items are not tabbable", isInert(h.dock.menu));
  assert("closed: the scrim is down", h.dock.scrim.hidden);
  assert("closed: no panel is up", h.dock.panels.every((p) => p.hidden));
  // Announced from the script, never from the markup: the panels are modal only in this
  // face, and the no-JS face renders them as a plain stack with nothing dimmed behind.
  // Markup carrying role="dialog" would lie to a reader who never runs this script.
  assert(
    "every panel is announced as a dialog",
    h.dock.panels.every((p) => p.getAttribute("role") === "dialog"),
  );
  assert(
    "every panel is announced as modal",
    h.dock.panels.every((p) => p.getAttribute("aria-modal") === "true"),
  );

  h.dock.launcher.click();
  assert("the launcher opens the menu", h.state() === "menu");
  assert("menu: the launcher reports itself expanded", h.dock.launcher.getAttribute("aria-expanded") === "true");
  assert("menu: the menu is no longer inert", !isInert(h.dock.menu));
  assert("menu: the scrim is still down — only a panel is modal", h.dock.scrim.hidden);

  h.item("search").click();
  assert("a bar item raises its panel", h.state() === "panel");
  assert("panel: that tool's panel is the one showing", !h.panel("search").hidden);
  assert("panel: every other panel stays down", h.panel("outline").hidden);
  assert("panel: the item reports itself expanded", h.item("search").getAttribute("aria-expanded") === "true");
  assert(`panel: the item carries .${DOCK_ITEM_ACTIVE_CLASS}`, h.item("search").classList.contains(DOCK_ITEM_ACTIVE_CLASS));
  assert("panel: the scrim is up", !h.dock.scrim.hidden);

  h.item("search").click();
  assert("a second tap on the active tool folds its panel away", h.state() === "menu");
  assert("folding away lowers the panel", h.panel("search").hidden);
  assert("folding away clears the item's expanded state", h.item("search").getAttribute("aria-expanded") === "false");
  assert("folding away lowers the scrim", h.dock.scrim.hidden);

  h.dock.launcher.click();
  assert("the launcher closes the menu again", h.state() === "closed");
  assert("closed again: the menu is inert again", isInert(h.dock.menu));

  // Every attribute is rewritten on every transition, so no stale value can survive a
  // change of screen [LAW:dataflow-not-control-flow]. Reached by the longest path.
  h.dock.launcher.click();
  h.item("search").click();
  h.item("outline").click();
  assert("moving between panels moves the active item", h.item("outline").classList.contains(DOCK_ITEM_ACTIVE_CLASS));
  assert("the previously active item is no longer active", !h.item("search").classList.contains(DOCK_ITEM_ACTIVE_CLASS));
  assert("the previously open panel is down", h.panel("search").hidden);
  assert("only one panel is ever up", h.dock.panels.filter((p) => !p.hidden).length === 1);
}

console.log("\nEscape unwinds one layer at a time:");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.body.classList.add("search-ready");

  escape(h);
  assert("Escape on a closed dock does nothing", h.state() === "closed");

  h.dock.launcher.click();
  h.item("search").click();
  escape(h);
  assert("Escape on a panel returns to the menu, not to closed", h.state() === "menu");
  escape(h);
  assert("a second Escape closes the menu", h.state() === "closed");
}

console.log("\nThe dock gets out of the way when the reader leaves it:");
{
  const h = mount([{ id: "outline" }]);

  h.dock.launcher.click();
  h.dock.scrim.click();
  assert("a click on the scrim closes the dock", h.state() === "closed");

  h.dock.launcher.click();
  h.doc.getElementById("header-link")?.click();
  assert("a click out on the page closes an open menu", h.state() === "closed");

  h.dock.launcher.click();
  h.item("outline").click();
  assert("a click INSIDE the dock leaves it open", h.state() === "panel");
  h.panel("outline").querySelector<HTMLElement>("button")?.click();
  assert("a plain control inside a panel leaves the panel up", h.state() === "panel");
  h.panel("outline").querySelector<HTMLElement>("a")?.click();
  assert("an anchor inside a panel closes the dock — it navigates the page behind", h.state() === "closed");
}

// ── Bug 2: focus dropped to <body> on every panel close ──────────────────────

console.log("\nEvery transition names where the caret lands (bug 2):");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.body.classList.add("search-ready");

  // A synthetic .click() does NOT focus its target the way a real click does (verified
  // against jsdom, and true of dispatched events in browsers too), so the caret is placed
  // explicitly here. That is exactly right for what is under test: this models a KEYBOARD
  // reader, which is the only reader the focus rule is for.
  h.dock.launcher.focus();
  h.dock.launcher.click();
  assert("opening the menu leaves the caret on the launcher", h.focused() === S.launcher);

  h.item("search").focus();
  h.item("search").click();
  assert("a panel whose first control is a text field takes the caret", h.focused() === "search-field");

  escape(h);
  assert("unwinding a panel hands the caret to the item that opened it", h.focused() === S.item);
  assert("...which is the search item specifically", h.doc.activeElement === h.item("search"));

  escape(h);
  assert("unwinding the menu hands the caret back to the launcher", h.focused() === S.launcher);
  assert("the caret NEVER falls to <body>", h.focused() !== "body");

  // The bug in its exact original shape: focus inside a panel, panel closes, caret gone.
  h.dock.launcher.click();
  h.item("search").click();
  h.panel("search").querySelector<HTMLInputElement>("input")?.focus();
  assert("precondition: the caret is in the panel's field", h.focused() === "search-field");
  h.dock.scrim.click();
  assert("closing a panel the reader was typing in does not drop the caret to <body>", h.focused() !== "body");
  assert("it lands on the launcher, one Tab from where they were", h.doc.activeElement === h.dock.launcher);

  // A panel of buttons keeps the caret on the menu item, so a keyboard reader is never
  // thrown to a control they did not ask for.
  h.dock.launcher.focus();
  h.dock.launcher.click();
  h.item("outline").click();
  assert("a panel with no text field leaves the caret on the menu item", h.doc.activeElement === h.item("outline"));
}

console.log("\nThe caret is only the dock's to move while it is inside the dock:");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.body.classList.add("search-ready");

  // A reader who has clicked out onto the page keeps the caret they just placed — the
  // dock re-projects itself but does not reach across and steal it.
  h.dock.launcher.click();
  const outside = h.doc.getElementById("minimap-button");
  outside?.focus();
  assert("precondition: the caret is outside the dock", h.focused() === "minimap-button");
  h.item("search").click();
  assert("opening a panel does not steal a caret placed outside the dock", h.focused() === "minimap-button");
  assert("...even though the panel did open", h.state() === "panel");
}

// ── Bug 4: the page left tabbable under the scrim ────────────────────────────

console.log("\nEverything outside the dock is inert exactly while a panel is open (bug 4):");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.body.classList.add("search-ready");

  // Named through the DOM rather than through anything the module hands back: these are
  // the regions a reader can see under the scrim, at BOTH levels above the dock — the
  // dock's own siblings inside <main>, and <main>'s siblings inside <body>.
  const outside = ["site-header", "site-footer", "minimap"].map((id) => {
    const el = h.doc.getElementById(id);
    if (el === null) throw new Error(`fixture is missing its #${id} region`);
    return el;
  });
  const noneInert = (): boolean => outside.every((el) => !isInert(el));
  const allInert = (): boolean => outside.every((el) => isInert(el));

  assert("closed: the page is fully reachable", noneInert());
  const page = h.doc.getElementById("page");
  if (page === null) throw new Error("fixture is missing its #page wrapper");
  h.dock.launcher.click();
  assert("menu: an open menu is not modal — the page stays reachable", noneInert());
  h.item("search").click();
  assert("panel: the page behind the scrim is inert", allInert());
  assert("panel: the dock itself is NOT inert", !isInert(h.dock.root));
  assert("panel: the open panel is NOT inert", !isInert(h.panel("search")));
  assert("panel: the dock's own ancestor is NOT inert — it contains the dock", !isInert(page));
  escape(h);
  assert("back to the menu: the page is reachable again", noneInert());
  escape(h);
  assert("closed: still reachable", noneInert());

  // The inert marking must survive every route out of a panel, not just the one Escape
  // takes — that is what "written on every transition" buys.
  h.dock.launcher.click();
  h.item("search").click();
  h.dock.scrim.click();
  assert("closing via the scrim releases the page too", noneInert());
  h.dock.launcher.click();
  h.item("search").click();
  h.panel("search").querySelector<HTMLElement>("a")?.click();
  assert("closing via an in-panel link releases the page too", noneInert());
}

console.log("\nA region the page appends AFTER mount is inert too (bug 4, found live):");
{
  // Found by driving the real page during slopspot-tool-dock-1mo: the minimap's <nav> and
  // its toggle are appended to <body> by the minimap's own script, which runs after the
  // dock has mounted. A set of outside regions collected once at mount could not contain
  // them, so with a modal panel open a keyboard reader could still tab onto four minimap
  // controls hidden underneath the scrim. Same defect as the availability latch: a set
  // sampled before the page had finished assembling itself.
  const h = mount([{ id: "outline" }]);

  const late = h.doc.createElement("nav");
  late.id = "late-rail";
  late.innerHTML = `<button type="button">rail</button>`;
  h.body.append(late);

  h.dock.launcher.click();
  h.item("outline").click();
  assert("precondition: a panel is open", h.state() === "panel");
  assert("a region appended after mount is inert while the panel is up", isInert(late));
  escape(h);
  assert("...and is released again when the panel closes", !isInert(late));
}

// ── Bug 3: an unrelated loop driving the render ──────────────────────────────

console.log("\nAvailability is re-read on a gate change and on nothing else (bug 3):");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);

  assert("a tool whose capability has not arrived is not offered", h.item("search").hidden);
  assert("an ungated tool is offered from the start", !h.item("outline").hidden);

  // Whether a render RAN is not visible in the DOM — the projection is idempotent, so a
  // second render of the same state is indistinguishable from none. So: tamper with a
  // value only `render` writes, then see whether the tamper survives. A render restores
  // it; no render leaves it. Behaviour, observed from outside [LAW:behavior-not-structure].
  const tamper = (): void => {
    h.dock.root.dataset.state = "tampered";
  };
  const rendered = (): boolean => h.state() !== "tampered";

  tamper();
  // The minimap rewrites `has-timeline` on every resize tick. Sixty of these per second
  // drove sixty dock renders before the observer was narrowed to the gate signature.
  h.body.classList.add("has-timeline");
  await h.settle();
  assert("an unrelated body class does not re-render the dock", !rendered());

  tamper();
  h.body.classList.remove("has-timeline");
  h.body.classList.add("has-timeline");
  await h.settle();
  assert("churning an unrelated class does not re-render it either", !rendered());

  tamper();
  // The DOM dirties the class attribute even when the token set is unchanged, so the
  // observer fires on writes that change nothing at all. Verified against jsdom: this
  // write DOES deliver a mutation record.
  h.body.className = h.body.className;
  await h.settle();
  assert("rewriting body's class to the same value does not re-render it", !rendered());

  tamper();
  h.body.classList.add("search-ready");
  await h.settle();
  assert("a gate class arriving DOES re-render the dock", rendered());
  assert("...and the tool it gates is now offered", !h.item("search").hidden);

  tamper();
  h.body.classList.remove("search-ready");
  await h.settle();
  assert("a gate class going away re-renders too — the door opens both ways", rendered());
  assert("...and the tool it gated is withdrawn", h.item("search").hidden);
}

console.log("\nA late-declaring tool reaches an already-open menu:");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready", field: true }]);
  h.dock.launcher.click();
  assert("precondition: the menu is open with the gated tool withheld", h.state() === "menu" && h.item("search").hidden);
  h.body.classList.add("search-ready");
  await h.settle();
  assert("the tool joins the menu without the reader closing and reopening it", !h.item("search").hidden);
  assert("the open menu stays open across the re-render", h.state() === "menu");
}

// ── Bug 1: the permanently-latched hidden dock ───────────────────────────────

console.log("\nA dock with nothing reachable hides — and comes back (bug 1):");
{
  // EVERY tool gated, and no capability class present: the exact situation at first paint
  // on a page whose tool scripts have not run yet. The original bug sampled availability
  // once, here, and hid the dock — and because every route back to a render ran through
  // the launcher the hide had just removed, the dock never returned for the rest of the
  // page's life. A one-way door.
  const h = mount([
    { id: "search", requires: "search-ready", field: true },
    { id: "tldr", requires: "tldr-ready" },
  ]);

  assert("with no capability at all, the dock hides rather than offering an empty row", h.dock.root.hidden);
  assert("...and both of its tools are withheld", h.item("search").hidden && h.item("tldr").hidden);

  h.body.classList.add("tldr-ready");
  await h.settle();
  assert("a tool declaring late brings the dock BACK — the hide does not latch", !h.dock.root.hidden);
  assert("...offering exactly the tool that declared", !h.item("tldr").hidden && h.item("search").hidden);

  h.dock.launcher.click();
  assert("and the recovered dock is fully operable", h.state() === "menu");
  h.item("tldr").click();
  assert("its late tool opens", h.state() === "panel" && !h.panel("tldr").hidden);

  // Withdraw the capability while that tool's panel is OPEN and the caret is inside it —
  // the sequence that made the page unusable before the state was settled on a gate change.
  h.panel("tldr").querySelector<HTMLInputElement>("input")?.focus();
  h.body.classList.remove("tldr-ready");
  await h.settle();
  assert("the last capability going away hides the dock again", h.dock.root.hidden);
  // The trap: the dock went display:none while `state` still said "panel", so every region
  // outside it stayed inert. Dock unreachable, page unreachable — nothing on the document
  // was operable for the rest of its life. Settling the state on a gate change is what
  // removes it, and this is the assertion that would have caught it.
  assert(
    "...and does NOT leave the page inert behind it — no keyboard trap",
    ["site-header", "site-footer", "minimap"].every(
      (id) => h.doc.getElementById(id)?.hasAttribute("inert") === false,
    ),
  );
  assert("...the dock no longer claims a panel is open", h.state() === "closed");
  // Deliberately NOT asserted: where the caret ends up. jsdom does not block .focus() on a
  // hidden element, so any claim here would pass on a behaviour jsdom fabricates and a real
  // browser does not share. What matters — and is true in both — is that the page is
  // reachable again, so a reader whose caret was dropped can Tab back into it.
}

console.log("\nA capability arriving elsewhere never disturbs a caret that is still valid:");
{
  // A gate change is not a transition the reader asked for, so it may only RESCUE a caret,
  // never place one. Every gated tool's script wires up on its own schedule, so a reader
  // typing in one panel while another tool finishes loading is the ordinary case, not an
  // exotic one — and yanking them onto the launcher there is bug 2 arriving through a door
  // the historical framing does not cover.
  const h = mount([
    { id: "search", requires: "search-ready", field: true },
    { id: "tldr", requires: "tldr-ready" },
  ]);
  h.body.classList.add("search-ready");
  await h.settle();

  h.dock.launcher.focus();
  h.dock.launcher.click();
  h.item("search").click();
  h.panel("search").querySelector<HTMLInputElement>("input")?.focus();
  assert("precondition: the reader is typing in the search panel's field", h.focused() === "search-field");

  h.body.classList.add("tldr-ready");
  await h.settle();
  assert("an unrelated capability ARRIVING leaves the caret in the field", h.focused() === "search-field");
  assert("...and the panel stays open", h.state() === "panel");
  assert("...while the tool that declared joins the menu", !h.item("tldr").hidden);

  h.body.classList.remove("tldr-ready");
  await h.settle();
  assert("an unrelated capability GOING AWAY leaves the caret alone too", h.focused() === "search-field");
  assert("...and withdraws only its own tool", h.item("tldr").hidden && h.state() === "panel");
}

console.log("\n...but a caret the render DOES take away is still rescued:");
{
  // The complement, and the reason the rule is "was the focused element stripped" rather
  // than "did the settled state differ". Here the state does NOT change — the dock stays in
  // `menu`, since `settle` only corrects an open panel — yet the render hides the very item
  // the caret is resting on. A rule keyed on the state would leave the reader on a hidden
  // element and drop them to <body>, which is precisely bug 2.
  const h = mount([{ id: "outline" }, { id: "tldr", requires: "tldr-ready" }]);
  h.body.classList.add("tldr-ready");
  await h.settle();

  h.dock.launcher.focus();
  h.dock.launcher.click();
  h.item("tldr").focus();
  assert("precondition: the caret rests on a gated menu item, dock in 'menu'", h.state() === "menu");
  assert("...on that item specifically", h.doc.activeElement === h.item("tldr"));

  h.body.classList.remove("tldr-ready");
  await h.settle();
  assert("the settled state is unchanged — this is not a panel", h.state() === "menu");
  assert("...yet the item the caret was on is now hidden", h.item("tldr").hidden);
  assert("the caret is rescued to the launcher rather than dropped", h.doc.activeElement === h.dock.launcher);
  assert("...and never falls to <body>", h.focused() !== "body");
}

console.log("\nWithdrawing one tool's capability leaves the others reachable:");
{
  // The same settlement, one step short of hiding the dock: the open tool goes away but
  // another remains, so the dock falls back to the menu rather than closing.
  const h = mount([{ id: "outline" }, { id: "tldr", requires: "tldr-ready" }]);
  h.body.classList.add("tldr-ready");
  await h.settle();
  h.dock.launcher.click();
  h.item("tldr").click();
  assert("precondition: the gated tool's panel is open", h.state() === "panel");

  h.body.classList.remove("tldr-ready");
  await h.settle();
  assert("the panel of a withdrawn tool does not stay open", h.state() === "menu");
  assert("...its panel is down", h.panel("tldr").hidden);
  assert(
    "...the page is not left inert",
    h.doc.getElementById("site-header")?.hasAttribute("inert") === false,
  );
  assert("...and the dock stays up on its remaining tool", !h.dock.root.hidden);
  assert("...which is still offered", !h.item("outline").hidden);
}

console.log("\nAn ungated tool alone is enough to keep the dock up:");
{
  const h = mount([{ id: "outline" }, { id: "search", requires: "search-ready" }]);
  assert("the dock is up on its always-available tool", !h.dock.root.hidden);
}

if (process.exitCode) {
  console.error("\nTool dock state-machine checks FAILED.");
} else {
  console.log("\nAll tool dock state-machine checks passed.");
}
