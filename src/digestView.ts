// [LAW:decomposition] What the reader sees of one turn's digest: the outcome written at the
// head of that turn's card. One sentence, no "and" — this module derives nothing, asks for
// nothing and waits for nothing; it is handed a turn's index and its outcome and makes the
// page show exactly that. The deriving is turnDigest.ts's, the consent and the walk are
// digestPanel.ts's.
//
// [LAW:one-source-of-truth] It writes into the conversation the renderer already emitted,
// found by the one navigational contract that renderer documents — `:scope > [data-index]`
// on the conversation section, the same contract the minimap reads — so a digest cannot
// appear against a turn the renderer never drew. It adds no second enumeration of turns.
//
// [LAW:dataflow-not-control-flow] One outcome in, one shape out, with `none` erasing rather
// than hiding: a turn too short for a digest carries no element at all, so "no digest
// affordance" is the absence of markup and not a class someone can accidentally show.
//
// [LAW:no-silent-failure] The model's words reach the page as TEXT and never as markup —
// `textContent`, never `innerHTML`, and the summarizer is asked for plain text in the first
// place (summarizerSource.DIGEST_OPTIONS) — so there is no sanitizing step here to get
// wrong. A failed turn says it failed, with the reason, and its own text is untouched.

import type { DigestOutcome } from "./turnDigest";

// The one class the stylesheet dresses and the one attribute it switches on. Exported
// because scripts/digest-view-check.ts asserts against these names and the page's CSS is
// written to them [LAW:one-source-of-truth].
export const DIGEST_CLASS = "turn-digest";
export const DIGEST_STATE = "data-digest";

// The head of a turn card, where a digest goes: directly after the role line. A shown turn
// is an <article> whose role line is its own child; a folded turn is a <details> whose role
// line sits inside its body — the renderer's two shapes, both selected here, and neither
// selector can reach a NESTED transcript's role line (those live several levels down inside
// a <details class="condensed">) [LAW:one-source-of-truth].
const ROLE_LINE = ":scope > .bubble-role, :scope > .collapsed-turn-body > .bubble-role";

// [LAW:types-are-the-program] The parts of one digest element, made together so no arm can
// leave a half-built one: the label a reader reads it by, the text itself, and the mark that
// says this digest was combined from the digests of a turn too long for one pass.
interface DigestParts {
  readonly root: HTMLElement;
  readonly text: HTMLElement;
  readonly combined: HTMLElement;
}

const buildParts = (document: Document): DigestParts => {
  const root = document.createElement("aside");
  root.className = DIGEST_CLASS;
  // An aside with its own label, so a screen reader meets it as the turn's digest and not as
  // the first sentence of the turn. The source's own turn-summary block is a different
  // aside with a different class and a different label; the two are never confused.
  root.setAttribute("aria-label", "Digest of this turn");
  const mark = document.createElement("span");
  mark.className = "turn-digest-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "✦";
  const text = document.createElement("p");
  text.className = "turn-digest-text";
  const combined = document.createElement("span");
  combined.className = "turn-digest-combined";
  combined.textContent = "combined";
  combined.title = "This turn was longer than the summarizer takes at once: its parts were digested, then digested together.";
  // [LAW:one-way-deps] exception: appendChild one at a time rather than append(a, b, c),
  // because `src` is type-checked with worker-configuration.d.ts, whose HTMLRewriter
  // `Element` declaration-merges with the DOM's and hides the variadic form (voicePicker.ts
  // carries the same note). Nothing about the built page differs.
  for (const part of [mark, text, combined]) root.appendChild(part);
  return { root, text, combined };
};

// [LAW:dataflow-not-control-flow] Each outcome kind names the two values that differ — the
// sentence shown and whether the combined mark is there — so the writer below branches on
// nothing and a new outcome arm stops compiling until it is answered here.
const shownText = (outcome: Exclude<DigestOutcome, { kind: "none" }>): string => {
  switch (outcome.kind) {
    case "pending":
      return "Summarizing…";
    case "ready":
      return outcome.text;
    case "failed":
      return `No digest: ${outcome.reason}`;
  }
};

export interface DigestView {
  // Show this turn's outcome at its head. A turn the conversation does not carry is a
  // caller's bug, thrown — the service's indices and the renderer's are the same indices.
  write(index: number, outcome: DigestOutcome): void;
}

export const createDigestView = (conversation: HTMLElement): DigestView => {
  const document = conversation.ownerDocument;
  const shown = new Map<number, DigestParts>();

  const turnAt = (index: number): HTMLElement => {
    const turn = conversation.querySelector<HTMLElement>(`:scope > [data-index="${index}"]`);
    // [LAW:no-defensive-null-guards] Every index the service holds came from the same
    // derived view this page rendered, so a missing turn is a broken invariant between the
    // renderer and the service, not a case to skip quietly.
    if (turn === null) throw new RangeError(`the conversation has no turn ${index} to digest`);
    return turn;
  };

  return {
    write: (index, outcome) => {
      const held = shown.get(index);
      if (outcome.kind === "none") {
        held?.root.remove();
        shown.delete(index);
        return;
      }
      const parts = held ?? buildParts(document);
      if (held === undefined) {
        const turn = turnAt(index);
        const role = turn.querySelector<HTMLElement>(ROLE_LINE);
        // [LAW:no-defensive-null-guards] The renderer emits a role line on every spine node,
        // in both its shapes; its absence is a renderer change that broke this view, and it
        // should say so rather than drop digests silently on one shape of turn.
        if (role === null) throw new Error(`turn ${index} has no role line to put its digest after`);
        // The same merged-Element reason as above: insertBefore against the role line's own
        // next sibling is `after` written in the methods that survive the merge. A role line
        // that is its parent's last child has a null nextSibling, which insertBefore reads as
        // "at the end" — exactly where the digest belongs there. The parent is not optional:
        // `role` was just found INSIDE `turn`, so it has one [LAW:no-defensive-null-guards].
        role.parentNode!.insertBefore(parts.root, role.nextSibling);
        shown.set(index, parts);
      }
      parts.root.setAttribute(DIGEST_STATE, outcome.kind);
      parts.text.textContent = shownText(outcome);
      parts.combined.hidden = !(outcome.kind === "ready" && outcome.combined);
    },
  };
};
