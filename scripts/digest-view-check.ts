// What a turn shows for its digest (slopspot-turn-digest-8xc.44n), written into the HTML the
// read renderer actually emits — a shown turn, a folded one, and the nested transcript that
// must never be mistaken for either. Run: `tsx scripts/digest-view-check.ts`.
//
// [LAW:behavior-not-structure] Nothing here asserts a colour, a layout or how the element is
// built — only what a reader can observe: which turns carry a digest, what it says, and that
// the model's words arrive as text and never as markup.

import { JSDOM } from "jsdom";
import { DIGEST_CLASS, DIGEST_STATE, createDigestView } from "../src/digestView";
import { deriveViewableDialogue } from "../src/overlay";
import { renderDialogueHtml } from "../src/renderDialogue";
import type { Overlay, Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const user = (content: string): Turn => ({ kind: "message", role: "user", content });
const assistant = (content: string): Turn => ({ kind: "message", role: "assistant", content });

// The page as the reader gets it: the renderer's own HTML inside the section the page draws
// it in, so the view is asserted against the markup it will really meet [LAW:one-source-of-truth].
const page = (turns: ReadonlyArray<Turn>, overlay: Overlay = []) => {
  const html = renderDialogueHtml(deriveViewableDialogue({ turns, overlay }));
  const dom = new JSDOM(`<!doctype html><section class="conversation">${html}</section>`);
  const conversation = dom.window.document.querySelector<HTMLElement>(".conversation");
  if (conversation === null) throw new Error("the fixture lost its conversation");
  return { conversation, view: createDigestView(conversation) };
};

const digestIn = (conversation: HTMLElement, index: number): HTMLElement | null =>
  conversation.querySelector<HTMLElement>(`:scope > [data-index="${index}"] .${DIGEST_CLASS}`);

console.log("a digest sits at the head of its own turn");
{
  const { conversation, view } = page([user("a question"), assistant("an answer"), user("another")]);
  view.write(1, { kind: "ready", text: "the assistant answers", combined: false });
  const digest = digestIn(conversation, 1);
  assert("the turn it names carries it", digest !== null);
  assert("no other turn does", digestIn(conversation, 0) === null && digestIn(conversation, 2) === null);
  assert("it says what the summarizer said", digest?.textContent?.includes("the assistant answers") === true);
  assert("it carries the outcome's kind, for the stylesheet", digest?.getAttribute(DIGEST_STATE) === "ready");
  // The role line names who is speaking; a digest read before it would be a digest of nobody.
  const turn = conversation.querySelector<HTMLElement>(':scope > [data-index="1"]');
  const kids = [...(turn?.children ?? [])];
  assert(
    "it comes directly after the role line, ahead of the turn's own text",
    kids.findIndex((el) => el.classList.contains("bubble-role")) + 1 === kids.findIndex((el) => el.classList.contains(DIGEST_CLASS)),
  );
}

console.log("a folded turn keeps its digest inside the fold, where its role line is");
{
  const { conversation, view } = page([user("a question"), assistant("an answer")], [{ kind: "collapse", target: { kind: "turn", index: 1 } }]);
  const turn = conversation.querySelector<HTMLElement>(':scope > [data-index="1"]');
  assert("the fixture really folded the turn", turn?.tagName.toLowerCase() === "details");
  view.write(1, { kind: "ready", text: "folded but digested", combined: false });
  assert("the digest is in the fold's body", turn?.querySelector(`.collapsed-turn-body > .${DIGEST_CLASS}`) !== null);
  assert("and not in its summary, which would show the digest twice over", turn?.querySelector(`.collapsed-turn-summary .${DIGEST_CLASS}`) === null);
}

console.log("every outcome the service can report");
{
  const { conversation, view } = page([assistant("an answer")]);
  view.write(0, { kind: "pending" });
  assert("pending says so rather than showing an empty box", digestIn(conversation, 0)?.textContent?.includes("Summarizing") === true);
  view.write(0, { kind: "failed", reason: "the summarizer answered nothing" });
  const failed = digestIn(conversation, 0);
  assert("a failure names itself and its reason", failed?.textContent?.includes("the summarizer answered nothing") === true);
  assert("and is marked failed, not ready", failed?.getAttribute(DIGEST_STATE) === "failed");
  assert("the turn's own text is untouched by the failure", conversation.textContent?.includes("an answer") === true);
  view.write(0, { kind: "ready", text: "a digest at last", combined: false });
  assert("a later success replaces the reason rather than standing beside it", digestIn(conversation, 0)?.textContent?.includes("the summarizer answered nothing") === false);
  assert("one element throughout — the reader sees one digest, not four", conversation.querySelectorAll(`.${DIGEST_CLASS}`).length === 1);
  view.write(0, { kind: "none" });
  assert("none removes it: a turn too short for a digest carries no affordance at all", digestIn(conversation, 0) === null);
}

console.log("a combined digest says it was combined");
{
  const { conversation, view } = page([assistant("an answer")]);
  view.write(0, { kind: "ready", text: "one digest of many", combined: true });
  const mark = digestIn(conversation, 0)?.querySelector<HTMLElement>(".turn-digest-combined");
  assert("the mark is there", mark !== null && mark !== undefined && !mark.hidden);
  view.write(0, { kind: "ready", text: "one pass was enough", combined: false });
  assert("and gone when the digest was one pass", digestIn(conversation, 0)?.querySelector<HTMLElement>(".turn-digest-combined")?.hidden === true);
}

console.log("the model's words are text, never markup");
{
  const { conversation, view } = page([assistant("an answer")]);
  view.write(0, { kind: "ready", text: "<img src=x onerror=alert(1)> and <b>bold</b>", combined: false });
  const digest = digestIn(conversation, 0);
  assert("no element the model named exists", digest?.querySelector("img, b") === null);
  assert("the characters are shown as the model wrote them", digest?.textContent?.includes("<img src=x onerror=alert(1)> and <b>bold</b>") === true);
}

console.log("clearing leaves the conversation as the renderer wrote it");
{
  // Alternating speakers: the renderer groups consecutive assistant turns into ONE spine
  // node, so two assistant turns in a row would be one index, not two.
  const { conversation, view } = page([assistant("first"), user("between"), assistant("second")]);
  const before = conversation.innerHTML;
  view.write(0, { kind: "ready", text: "one", combined: false });
  view.write(2, { kind: "pending" });
  assert("both were written", conversation.querySelectorAll(`.${DIGEST_CLASS}`).length === 2);
  view.clear();
  assert("nothing of the digests is left", conversation.innerHTML === before);
}

console.log("a turn the conversation does not carry is a caller's bug, said out loud");
{
  const { view } = page([assistant("only one turn")]);
  const thrown = ((): unknown => {
    try {
      view.write(7, { kind: "pending" });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert("it throws rather than writing a digest nowhere", thrown instanceof RangeError);
}

console.log("a nested subagent transcript is not a turn and gets no digest of its own");
{
  const nested: Turn = {
    kind: "message",
    role: "assistant",
    content: "",
    blocks: [
      {
        kind: "subagent",
        agentType: "explorer",
        description: "look around",
        stepCount: 2,
        body: { kind: "captured", transcript: { turns: [user("inner question"), assistant("inner answer")] } },
      },
    ],
  } as unknown as Turn;
  const { conversation, view } = page([nested]);
  view.write(0, { kind: "ready", text: "the outer digest", combined: false });
  assert("exactly one digest on the page", conversation.querySelectorAll(`.${DIGEST_CLASS}`).length === 1);
  assert(
    "and it is the outer turn's, not the nested transcript's first role line",
    conversation.querySelector(`:scope > [data-index="0"] > .${DIGEST_CLASS}`) !== null,
  );
}

console.log(process.exitCode === 1 ? "digest-view-check: FAILED" : "digest-view-check: ok");
