// [LAW:single-enforcer] The ONE owner of the "clamp long prose to a default
// height with an Expand toggle" capability. Both surfaces that render the
// dialogue — the permalink page and the editor preview — call this exact
// function over their rendered root, so the affordance cannot drift between them.
// renderDialogue.ts is the single MARKUP boundary (it emits the `.clampable`
// wrapper); this is the single BEHAVIOUR boundary that animates it.
//
// [LAW:dataflow-not-control-flow] The toggle's PRESENCE is a value derived from
// one measured fact — does the prose overflow the clamp height — not a guess the
// renderer makes from text length. A block that fits gets no control; an
// overflowing block gets one.
//
// [LAW:one-source-of-truth] The clamp height lives in exactly one place: the CSS
// custom property the `.is-collapsed` rule reads. We never hardcode that height
// here. We add the collapse class, then ask the browser whether the content
// scrolls past it (scrollHeight > clientHeight) — geometry, never a magic number.
//
// [LAW:no-silent-failure] The collapsed state and the toggle are introduced
// together: a block is only left `.is-collapsed` once its toggle exists, so prose
// is never clamped without a way back. With JS absent this function never runs,
// the renderer's markup carries no clamp class, and every block renders fully
// expanded — degraded, never hidden-and-unrecoverable.

const COLLAPSED = "is-collapsed"; // clamp applied — the CSS max-height rule reads this
const MEASURED = "clamp-measured"; // has been evaluated at least once
const PINNED = "clamp-pinned"; // the reader toggled it — automatic re-evaluation must not stomp it
const EXPAND_LABEL = "Show more";
const COLLAPSE_LABEL = "Show less";

const clampContent = (wrapper: HTMLElement): HTMLElement => {
  const c = wrapper.querySelector<HTMLElement>(":scope > .clamp-content");
  // [LAW:no-silent-failure] renderDialogue always emits .clamp-content inside a
  // .clampable, so a missing child is a broken template invariant, not a normal
  // empty case — fail loudly rather than skip the block into silence.
  if (!c) throw new Error("clampable block has no .clamp-content");
  return c;
};

// The toggle owns its own label/aria, derived from the wrapper's collapsed state
// — one read, no duplicated "is it open" flag. [LAW:effects-at-boundaries] the
// click mutates a class; CSS owns the resulting visual. The click also PINS the
// block: from then on the reader's choice is authoritative and the width watcher
// leaves it alone ([LAW:no-ambient-temporal-coupling] — a resize must not reset a
// deliberate expand/collapse).
const makeToggle = (wrapper: HTMLElement): HTMLButtonElement => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "clamp-toggle";
  const sync = (): void => {
    const collapsed = wrapper.classList.contains(COLLAPSED);
    btn.textContent = collapsed ? EXPAND_LABEL : COLLAPSE_LABEL;
    btn.setAttribute("aria-expanded", String(!collapsed));
  };
  btn.addEventListener("click", () => {
    wrapper.classList.add(PINNED);
    wrapper.classList.toggle(COLLAPSED);
    sync();
  });
  sync();
  return btn;
};

const existingToggle = (wrapper: HTMLElement): HTMLButtonElement | null =>
  wrapper.querySelector<HTMLButtonElement>(":scope > .clamp-toggle");

// Evaluate a set of clampable wrappers against the CURRENT layout and bring each
// into the state its geometry dictates: clamped + toggle when it overflows, plain
// when it fits. [LAW:effects-at-boundaries] Batched into one layout pass — write
// the collapse class to ALL candidates, THEN read every geometry, THEN write the
// per-block decision — so reads never interleave with writes and the whole set
// forces at most one reflow. With the clamp applied, clientHeight is the capped
// height and scrollHeight is the full content, so overflow is their inequality.
// Idempotent: a block already in the right state keeps its (single) toggle.
const evaluate = (blocks: HTMLElement[]): void => {
  if (blocks.length === 0) return;
  for (const w of blocks) w.classList.add(COLLAPSED);
  const overflows = blocks.map((w) => {
    const c = clampContent(w);
    return c.scrollHeight > c.clientHeight + 1; // +1 absorbs sub-pixel rounding
  });
  blocks.forEach((w, i) => {
    const toggle = existingToggle(w);
    if (overflows[i]) {
      if (!toggle) w.appendChild(makeToggle(w)); // overflow → reveal the control
      return; // keep COLLAPSED (just re-applied) with its toggle present
    }
    w.classList.remove(COLLAPSED); // it fit — no clamp
    if (toggle) toggle.remove(); // and no dangling control
  });
};

// [LAW:no-ambient-temporal-coupling] A block measured once goes stale when the
// viewport WIDTH changes (a desktop resize, a tablet orientation flip) reflows the
// prose taller or shorter. The single owner of "re-measure on layout change" is
// this watcher, installed once for the document. It keys on innerWidth — our own
// clamp changes a block's HEIGHT, so watching height would feed back on itself;
// width is the independent reflow driver. It re-evaluates only MEASURED, non-PINNED
// blocks, so automatic state stays fresh while a reader's manual choice is left
// untouched. rAF-coalesced so a drag-resize forces one pass, not one per event.
let widthWatcherInstalled = false;
const installWidthWatcher = (): void => {
  if (widthWatcherInstalled) return;
  widthWatcherInstalled = true;
  let lastWidth = window.innerWidth;
  let scheduled = false;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // height-only change → ignore
    lastWidth = window.innerWidth;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      evaluate([
        ...document.querySelectorAll<HTMLElement>(
          `.clampable.${MEASURED}:not(.${PINNED})`,
        ),
      ]);
    });
  });
};

export const enhanceClampBlocks = (root: HTMLElement): void => {
  installWidthWatcher();
  // [LAW:dataflow-not-control-flow] Re-evaluate EVERY non-pinned clampable block,
  // not only freshly-rendered ones. The editor preview re-renders on each content
  // change, and a block's clamp state is a function of its CURRENT prose — so the
  // enhancer recomputes it from the live geometry rather than trusting a one-time
  // measurement. The discriminator for "leave it alone" is `clamp-pinned` (the
  // reader's explicit choice), never `clamp-measured`: re-measuring a pinned block
  // would silently reset a deliberate expand/collapse. clamp-measured is kept only
  // as the marker the width watcher reads to find enhanced blocks document-wide.
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(`.clampable:not(.${PINNED})`),
  ];
  for (const w of blocks) w.classList.add(MEASURED);
  evaluate(blocks);
};
