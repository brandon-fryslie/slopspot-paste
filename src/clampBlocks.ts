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
const MEASURED = "clamp-measured"; // processed once — makes re-runs idempotent
const EXPAND_LABEL = "Show more";
const COLLAPSE_LABEL = "Show less";

// The toggle owns its own label/aria, derived from the wrapper's collapsed state
// — one read, no duplicated "is it open" flag. [LAW:effects-at-boundaries] the
// click mutates a class; CSS owns the resulting visual.
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
    wrapper.classList.toggle(COLLAPSED);
    sync();
  });
  sync();
  return btn;
};

const clampContent = (wrapper: HTMLElement): HTMLElement => {
  const c = wrapper.querySelector<HTMLElement>(".clamp-content");
  // [LAW:no-silent-failure] renderDialogue always emits .clamp-content inside a
  // .clampable, so a missing child is a broken template invariant, not a normal
  // empty case — fail loudly rather than skip the block into silence.
  if (!c) throw new Error("clampable block has no .clamp-content");
  return c;
};

// `root` is the rendered container (the permalink `.conversation`, or the editor
// mount). Typed as HTMLElement rather than ParentNode because the Cloudflare
// Worker types in scope redefine the broader DOM interfaces; the concrete element
// both callers hold avoids that clash.
export const enhanceClampBlocks = (root: HTMLElement): void => {
  // Only blocks not already processed — re-running over a re-rendered preview
  // (lit replaces the subtree on a content change, yielding fresh un-marked
  // nodes) re-enhances the new nodes while skipping untouched ones, so this is
  // safe to call after every render.
  const fresh = [
    ...root.querySelectorAll<HTMLElement>(`.clampable:not(.${MEASURED})`),
  ];
  if (fresh.length === 0) return;

  // [LAW:effects-at-boundaries] Batched into one layout pass: write the collapse
  // class to ALL candidates, THEN read every geometry, THEN write the per-block
  // decision. Reads never interleave with writes, so we force at most one reflow
  // for the whole set instead of one per block (the measuring-every-block cost
  // the ticket flags). With the clamp applied, clientHeight is the capped height
  // and scrollHeight is the full content, so overflow is their inequality.
  for (const w of fresh) w.classList.add(COLLAPSED, MEASURED);
  const overflows = fresh.map((w) => {
    const c = clampContent(w);
    return c.scrollHeight > c.clientHeight + 1; // +1 absorbs sub-pixel rounding
  });
  fresh.forEach((w, i) => {
    if (!overflows[i]) {
      w.classList.remove(COLLAPSED); // it fit — no clamp, no control
      return;
    }
    w.appendChild(makeToggle(w)); // overflow confirmed → reveal the control
  });
};
