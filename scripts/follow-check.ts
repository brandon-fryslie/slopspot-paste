// The follower: when the page scrolls to the read-along cursor and when it lets go
// (slopspot-read-along-a35.2). Run: `tsx scripts/follow-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a reader would notice: whether the
// page moved to the cursor, whether the Follow button is there, and which of the reader's
// gestures take the page from the voice. The browser is a stub of exactly the surface the
// follower reads (FollowView), so every reveal is a recorded call, not a scroll.

import { JSDOM } from "jsdom";
import { BAND_MARGIN, createFollower, follow, inBand, PAGING_KEYS, type FollowEvent, type FollowView, type Rect } from "../src/follow";
import type { Painted } from "../src/readAlong";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── the pure part ─────────────────────────────────────────────────────────────────────

console.log("follow");
{
  const events: ReadonlyArray<FollowEvent> = [{ kind: "reader" }, { kind: "follow" }, { kind: "turn" }];
  const table = events.map((event) => `${event.kind}=${follow(event)}`).join(" ");
  assert("the reader's own scroll releases; the Follow button and the voice moving on both restore following", table === "reader=released follow=following turn=following");
}

console.log("inBand");
{
  const height = 1000;
  const edge = height * BAND_MARGIN;
  assert("a rect wholly inside the middle half is in the band", inBand({ top: 400, bottom: 420 }, height));
  assert("the band's edges are inclusive", inBand({ top: edge, bottom: height - edge }, height));
  assert("a rect crossing the top edge is out", !inBand({ top: edge - 1, bottom: 300 }, height));
  assert("a rect crossing the bottom edge is out", !inBand({ top: 700, bottom: height - edge + 1 }, height));
  assert("above and below the viewport are out", !inBand({ top: -50, bottom: -30 }, height) && !inBand({ top: 1200, bottom: 1220 }, height));
  assert("the margin is a parameter: a zero margin is the whole viewport", inBand({ top: 0, bottom: height }, height, 0));
  assert("the paging keys are the ones that scroll a page from the keyboard", [...PAGING_KEYS].join() === "PageUp,PageDown,Home,End,ArrowUp,ArrowDown, ");
}

// ── the driver ────────────────────────────────────────────────────────────────────────

const dom = new JSDOM(`<!DOCTYPE html><body><main><p id="a">alpha</p><p id="b">beta</p></main><textarea id="edit"></textarea><button id="follow" hidden>Follow</button></body>`);
const { window } = dom;
const doc = window.document;
// The driver asks whether a key's target is an Element, the browser's global; installed
// here as view-check.ts does, before the follower is built.
(globalThis as Record<string, unknown>)["Element"] = window.Element;
const el = (id: string): Element => {
  const found = doc.getElementById(id);
  if (found === null) throw new Error(`fixture: no #${id}`);
  return found;
};
const button = el("follow") as HTMLButtonElement;
const alpha = el("a");
const beta = el("b");

// A page of fixed geometry: each element's rect is looked up, every reveal is recorded,
// and the scrollbar is the rightmost 16px.
const HEIGHT = 1000;
const SCROLLBAR_X = 1004;
const rects = new Map<Element, Rect>();
const revealed: Element[] = [];
const view: FollowView = {
  viewportHeight: () => HEIGHT,
  rectOf: (target) => {
    const rect = rects.get(target);
    if (rect === undefined) throw new Error("fixture: no rect for the element");
    return rect;
  },
  reveal: (target) => {
    revealed.push(target);
  },
  scrollbarAt: (x) => x >= SCROLLBAR_X,
};
const IN_BAND: Rect = { top: 480, bottom: 500 };
const OUT_OF_BAND: Rect = { top: 900, bottom: 920 };
const painted = (anchor: string, target: Element): Painted => ({ anchor, el: target });
const reveals = (): string => revealed.map((target) => target.id).join();
const gesture = (type: string): void => {
  window.dispatchEvent(new window.Event(type));
};
const key = (name: string, target: EventTarget = window): void => {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }));
};
const pointer = (x: number): void => {
  window.dispatchEvent(new window.MouseEvent("pointerdown", { clientX: x, clientY: 300 }));
};

console.log("createFollower");
{
  const follower = createFollower({ view, gestures: window, button });
  assert("starts following, with no cursor and the button hidden", follower.state() === "following" && button.hidden);

  rects.set(alpha, IN_BAND);
  follower.cursor(painted("t1", alpha));
  assert("a cursor inside the band is left where it is", reveals() === "" && button.hidden);

  rects.set(alpha, OUT_OF_BAND);
  follower.cursor(painted("t1", alpha));
  assert("a cursor that has left the band is revealed", reveals() === "a");

  gesture("wheel");
  assert("the wheel releases the page and shows the Follow button", follower.state() === "released" && !button.hidden);
  revealed.length = 0;
  follower.cursor(painted("t1", alpha));
  assert("a released page does not move to the cursor", reveals() === "");

  rects.set(beta, OUT_OF_BAND);
  follower.cursor(painted("t2", beta));
  assert("the voice moving on to another turn takes the page back: following, revealed, button hidden", follower.state() === "following" && reveals() === "b" && button.hidden);

  revealed.length = 0;
  gesture("touchmove");
  assert("a touch scroll releases too", follower.state() === "released" && !button.hidden);
  button.click();
  assert("the Follow button follows again and recentres the cursor at once", follower.state() === "following" && reveals() === "b" && button.hidden);

  revealed.length = 0;
  key("PageDown");
  assert("a paging key releases", follower.state() === "released");
  follower.send({ kind: "follow" });
  key("PageDown", el("edit"));
  assert("a paging key inside an editable element is typing, not scrolling", follower.state() === "following");
  key("k");
  assert("a letter is not a scroll", follower.state() === "following");

  pointer(300);
  assert("a pointer on the content is a tap, not a scroll", follower.state() === "following");
  pointer(SCROLLBAR_X + 2);
  assert("a pointer on the scrollbar is the reader taking the page", follower.state() === "released" && !button.hidden);

  follower.cursor(null);
  assert("with nothing painted there is nothing to follow: the button hides even while released", button.hidden && follower.state() === "released");

  follower.dispose();
  follower.send({ kind: "follow" });
  gesture("wheel");
  assert("after dispose the reader's gestures no longer reach the follower", follower.state() === "following");
}

console.log(process.exitCode === 1 ? "follow-check: FAILED" : "follow-check: ok");
