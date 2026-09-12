// The transport's keyboard: which gesture each key is, and which presses belong to the page
// instead (slopspot-read-along-a35.3). Run: `tsx scripts/shortcuts-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a reader would notice: space plays,
// the arrows nudge, the brackets skip a turn, minus and plus change speed — and none of them
// fires while they are typing in the editor, the ask box or the scrubber, or while a
// modifier makes the press the browser's.

import { JSDOM } from "jsdom";
import type { Gesture } from "../src/listenPanel";
import { NUDGE_SECONDS, shortcut, type Press } from "../src/shortcuts";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const dom = new JSDOM(
  `<!DOCTYPE html><body><main><p id="prose">alpha</p></main>` +
    `<textarea id="edit"></textarea><input id="ask" /><input id="scrub" type="range" />` +
    `<button id="stop">Stop</button><details id="fold"><summary id="sum">more</summary></details></body>`,
);
const { window } = dom;
(globalThis as Record<string, unknown>)["Element"] = window.Element;
const el = (id: string): Element => {
  const found = window.document.getElementById(id);
  if (found === null) throw new Error(`fixture: no #${id}`);
  return found;
};

// A press on the page's prose, unless told otherwise: the reader reading, not typing.
const press = (key: string, target: EventTarget | null = el("prose"), held: Partial<Press> = {}): Press => ({
  key,
  target,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...held,
});
const say = (gesture: Gesture | null): string => {
  if (gesture === null) return "none";
  switch (gesture.kind) {
    case "tap":
      return `tap ${gesture.control}`;
    case "mark":
      return `mark ${gesture.to.utterance}:${gesture.to.char}`;
    case "scrub":
      return `scrub ${gesture.toMs}`;
    case "nudge":
      return `nudge ${gesture.bySeconds}`;
    case "turn":
      return `turn ${gesture.by}`;
    case "speed":
      return `speed ${gesture.by}`;
  }
};
const of = (key: string, target?: EventTarget | null, held?: Partial<Press>): string => say(shortcut(press(key, target, held)));

console.log("shortcut: the transport's keys");
{
  assert("space is play and pause", of(" ") === "tap play");
  assert("the arrows nudge ten seconds either way", of("ArrowLeft") === `nudge ${-NUDGE_SECONDS}` && of("ArrowRight") === `nudge ${NUDGE_SECONDS}`);
  assert("the brackets skip a turn", of("[") === "turn -1" && of("]") === "turn 1");
  assert("minus and plus step the speed, under either name the layout gives them", of("-") === "speed -1" && of("_") === "speed -1" && of("+") === "speed 1" && of("=") === "speed 1");
  assert("the page keeps the keys it scrolls with", of("ArrowUp") === "none" && of("ArrowDown") === "none" && of("PageDown") === "none" && of("Home") === "none");
  assert("an unbound key is nobody's gesture", of("k") === "none" && of("Enter") === "none" && of("Escape") === "none");
}

console.log("shortcut: the presses that are not gestures");
{
  assert("typing in the editor is typing", of(" ", el("edit")) === "none" && of("[", el("edit")) === "none" && of("-", el("edit")) === "none");
  assert("typing in the ask box is typing", of(" ", el("ask")) === "none" && of("+", el("ask")) === "none");
  assert("the arrows on the scrubber are the scrubber's own", of("ArrowLeft", el("scrub")) === "none" && of("ArrowRight", el("scrub")) === "none");
  assert("space on a focused button presses the button", of(" ", el("stop")) === "none");
  assert("space on a fold's summary opens the fold", of(" ", el("sum")) === "none");
  assert("but a bracket typed at a focused button is still a turn skip: only space is a button's", of("]", el("stop")) === "turn 1");
  assert("a modifier makes the press the browser's or the system's", of("[", el("prose"), { metaKey: true }) === "none" && of(" ", el("prose"), { ctrlKey: true }) === "none" && of("-", el("prose"), { altKey: true }) === "none");
  assert("shift does NOT, since '+' is a shifted key on most layouts", of("+", el("prose")) === "speed 1");
  assert("a press with no element under it is still the reader's", of(" ", null) === "tap play");
}

console.log(process.exitCode === 1 ? "shortcuts-check: FAILED" : "shortcuts-check: ok");
