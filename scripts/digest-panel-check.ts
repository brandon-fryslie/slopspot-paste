// The page's digest affordance (slopspot-turn-digest-8xc.44n) under jsdom: a browser with no
// Summarizer, one whose model must download, one that refuses the create, and one ready to
// go — and what the reader is asked, told and shown in each.
// Run: `tsx scripts/digest-panel-check.ts`.
//
// [LAW:behavior-not-structure] The assertions are what a reader can observe: whether the ask
// is on the page, what its button says, what the turns carry. Nothing counts calls through a
// hook that exists only for this file, and nothing waits a number of ticks — every wait is
// `settled()`, the panel's own answer to "is anything in flight".

import { JSDOM } from "jsdom";
import { PREFERENCE_KEY, readPreference, writePreference } from "../src/digestConsent";
import { ASK_LABEL, ASK_NOTE, RETRY_LABEL, createDigestPanel, openingOf, type DigestControls } from "../src/digestPanel";
import { DIGEST_CLASS } from "../src/digestView";
import { deriveViewableDialogue } from "../src/overlay";
import { renderDialogueHtml } from "../src/renderDialogue";
import type { HeldSummarizer, SummarizerAvailability, SummarizerSource } from "../src/summarizerSource";
import type { Turn } from "../src/types";
import { DIGEST_MIN_WORDS, digestTurnsOf, type DigestTurn } from "../src/turnDigest";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────

// A promise the check opens when it chooses: the way this file holds work still while it
// looks at the page, instead of waiting a number of ticks and hoping.
const gate = (): { readonly waited: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open: () => open() };
};

const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const user = (content: string): Turn => ({ kind: "message", role: "user", content });
const assistant = (content: string): Turn => ({ kind: "message", role: "assistant", content });

// A conversation whose turns are all long enough to want a digest, except the last.
const TURNS: ReadonlyArray<Turn> = [
  assistant(words(DIGEST_MIN_WORDS + 20, "a")),
  user(words(DIGEST_MIN_WORDS + 20, "b")),
  assistant(words(DIGEST_MIN_WORDS + 20, "c")),
  user("too short to need one"),
];

const DIGEST_TURNS = digestTurnsOf(deriveViewableDialogue({ turns: TURNS, overlay: [] }));

// A summarizer that answers a digest naming its input's first word, so a digest can be
// traced to the turn it came from.
const heldStub = (): HeldSummarizer & { destroyed: () => boolean } => {
  let destroyed = false;
  return {
    inputQuota: 1_000_000,
    measureInputUsage: async (input) => input.length,
    summarize: async (input) => `digest of ${input.split(/\s+/)[0]}`,
    destroy: () => {
      destroyed = true;
    },
    destroyed: () => destroyed,
  };
};

interface Browser {
  readonly source: SummarizerSource;
  readonly creates: () => number;
  readonly held: () => ReturnType<typeof heldStub> | null;
  readonly report: (loaded: number) => void;
}

// A browser whose availability is fixed and whose create does what `answer` says. `report`
// pushes a download report through the monitor create was handed, as the real one would.
const browser = (availability: SummarizerAvailability, answer: () => Promise<HeldSummarizer>): Browser => {
  let creates = 0;
  let last: ReturnType<typeof heldStub> | null = null;
  const monitors: EventTarget[] = [];
  return {
    creates: () => creates,
    held: () => last,
    report: (loaded) => {
      for (const monitor of monitors) monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }));
    },
    source: {
      availability: async () => availability,
      create: async (options) => {
        creates += 1;
        const monitor = new EventTarget();
        monitors.push(monitor);
        options.monitor?.(monitor);
        const made = await answer();
        last = made as ReturnType<typeof heldStub>;
        return made;
      },
    },
  };
};

const ready = (): (() => Promise<HeldSummarizer>) => {
  const summarizer = heldStub();
  return async () => summarizer;
};

const refuses = (reason: string): (() => Promise<HeldSummarizer>) => async () => {
  throw new Error(reason);
};

const mount = (config: {
  readonly source: SummarizerSource | null;
  readonly remembered?: boolean;
  readonly connection?: { readonly type?: string; readonly saveData?: boolean };
  // The turns the page hands the panel. Defaults to the ones this conversation really has;
  // a check that wants them to DISAGREE with the rendered conversation passes its own.
  readonly turns?: ReadonlyArray<DigestTurn>;
}) => {
  const html = renderDialogueHtml(deriveViewableDialogue({ turns: TURNS, overlay: [] }));
  const dom = new JSDOM(
    `<!doctype html>` +
      `<section class="digest-ask" hidden>` +
      `<button class="digest-open" type="button"></button>` +
      `<label><input class="digest-always" type="checkbox"> Always</label>` +
      `<p class="digest-note"></p>` +
      `<progress class="digest-progress" max="1" value="0"></progress>` +
      `</section>` +
      `<section class="conversation">${html}</section>`,
  );
  const { document } = dom.window;
  const pick = <T extends Element>(selector: string): T => {
    const el = document.querySelector<T>(selector);
    if (el === null) throw new Error(`the fixture has no ${selector}`);
    return el;
  };
  const controls: DigestControls = {
    root: pick<HTMLElement>(".digest-ask"),
    open: pick<HTMLButtonElement>(".digest-open"),
    always: pick<HTMLInputElement>(".digest-always"),
    note: pick<HTMLElement>(".digest-note"),
    progress: pick<HTMLProgressElement>(".digest-progress"),
  };
  const store = memoryPreferences();
  if (config.remembered === true) writePreference(store, true);
  const conversation = pick<HTMLElement>(".conversation");
  const turns = config.turns ?? DIGEST_TURNS;
  const faults: string[] = [];
  // Every time the page is told a turn gained its digest — the door Listen's composition
  // waits at (src/pages/[slug].astro), counted so a check can see it is knocked on for a
  // digest and for nothing else.
  const arrivals: number[] = [];
  const panel = createDigestPanel({
    controls,
    conversation,
    turns,
    source: config.source,
    store,
    connection: config.connection,
    gestures: dom.window,
    implementation: "stub",
    onDigest: () => arrivals.push(arrivals.length),
    onFault: (what) => faults.push(what),
  });
  const digests = (): ReadonlyArray<string> =>
    [...conversation.querySelectorAll<HTMLElement>(`.${DIGEST_CLASS}`)].map((el) => el.textContent ?? "");
  return { panel, controls, store, conversation, digests, arrivals, faults, window: dom.window };
};

// ── the pure decision ────────────────────────────────────────────────────────────────

console.log("what the page does about getting a summarizer, before anything is attempted");
{
  assert("no model at all: nothing is offered", openingOf("unavailable", "none") === "none" && openingOf("unavailable", "download") === "none");
  assert("a model already there: try it, the reader is asked nothing", openingOf("available", "none") === "attempt");
  assert("a remembered yes cannot conjure a model the browser does not have", openingOf("unavailable", "download") === "none");
  assert("downloadable, nothing remembered: ask", openingOf("downloadable", "none") === "ask");
  assert("downloadable, remembered: try rather than ask again", openingOf("downloadable", "download") === "attempt");
  assert("already downloading for another page is the same case — create still wants the tap", openingOf("downloading", "none") === "ask" && openingOf("downloading", "download") === "attempt");
}

// ── the browser that cannot ──────────────────────────────────────────────────────────

console.log("a browser with no Summarizer offers nothing anywhere on the page");
{
  const { panel, controls, digests } = mount({ source: null });
  await panel.settled();
  assert("the stage says so", panel.stage().kind === "unavailable");
  assert("the ask is not on the page", controls.root.hidden);
  assert("and no turn carries a digest", digests().length === 0);
  panel.dispose();
}

console.log("a browser whose model is unavailable is the same silence, and nothing is created");
{
  const model = browser("unavailable", ready());
  const { panel, controls, digests } = mount({ source: model.source });
  await panel.settled();
  assert("the stage says so", panel.stage().kind === "unavailable");
  assert("the ask is not on the page", controls.root.hidden);
  assert("no summarizer was made", model.creates() === 0);
  assert("no turn carries a digest", digests().length === 0);
  panel.dispose();
}

// ── the browser that is ready ────────────────────────────────────────────────────────

console.log("a browser whose model is already there: no ask, no download, digests");
{
  const model = browser("available", ready());
  const { panel, controls, digests, faults } = mount({ source: model.source });
  await panel.settled();
  assert("the reader was never asked", controls.root.hidden && panel.stage().kind === "working");
  assert("one summarizer was made", model.creates() === 1);
  assert("the three long turns carry a digest", digests().length === 3);
  assert("the short turn carries none", digests().every((text) => !text.includes("too short")));
  assert("each digest is of its own turn", digests()[0]?.includes("digest of a0") === true && digests()[1]?.includes("digest of b0") === true);
  assert("nothing was said in the console", faults.length === 0);
  panel.dispose();
}

console.log("what the narrator is given to say before each turn");
{
  const model = browser("available", ready());
  const { panel, digests, arrivals } = mount({ source: model.source });
  assert("before anything is derived the narrator has nothing: the map is empty, not a turn with a blank", panel.digests().size === 0);
  await panel.settled();
  const said = panel.digests();
  assert("the three long turns are in it, by the index the renderer drew them under", [...said.keys()].join() === "0,1,2");
  assert("the short turn is not: a turn that is its own digest has none to say", said.size === 3 && digests().length === 3);
  assert("each carries its own turn's digest, as text and not as an outcome", said.get(0) === "digest of a0" && said.get(1) === "digest of b0");
  assert("the page was told once per digest, and only for a digest", arrivals.length === 3);
  panel.dispose();
}

console.log("a browser that cannot summarize gives the narrator nothing to say, and says so by saying nothing");
{
  const { panel, arrivals } = mount({ source: null });
  await panel.settled();
  assert("no service, no digests — never an outcome invented for a turn nobody looked at", panel.digests().size === 0);
  assert("and the page is never told there is something to say", arrivals.length === 0);
  panel.dispose();
}

console.log("every long turn says it is pending before its digest arrives");
{
  const held = heldStub();
  const opened = gate();
  const model = browser("available", async () => ({ ...held, summarize: async (input: string) => {
    await opened.waited;
    return held.summarize(input);
  } }));
  const { panel, digests } = mount({ source: model.source });
  // The panel paints what the service already knows before any summarize call returns, so
  // the wait below is for the create, not for a digest.
  while (digests().length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  assert("all three long turns are marked pending at once", digests().length === 3 && digests().every((text) => text.includes("Summarizing")));
  opened.open();
  await panel.settled();
  assert("and each becomes its digest", digests().every((text) => text.includes("digest of")));
  panel.dispose();
}

// ── the browser that must download ───────────────────────────────────────────────────

console.log("a model that must download: the reader is asked once, and the tap is the consent");
{
  const model = browser("downloadable", ready());
  const { panel, controls, digests } = mount({ source: model.source });
  await panel.settled();
  assert("the ask is on the page", !controls.root.hidden);
  assert("with the button that starts it", !controls.open.hidden && controls.open.textContent === ASK_LABEL);
  assert("and a sentence that names what happens, without inventing a size the browser never gave", controls.note.textContent === ASK_NOTE && !/\d+\s*(MB|GB)/.test(ASK_NOTE));
  assert("nothing has been created", model.creates() === 0 && digests().length === 0);
  assert("no progress bar before there is a download", controls.progress.hidden);

  controls.open.click();
  await panel.settled();
  assert("the tap made the summarizer", model.creates() === 1);
  assert("the ask leaves the page once it has been answered", controls.root.hidden && panel.stage().kind === "working");
  assert("and the digests arrive", digests().length === 3);
  panel.dispose();
}

console.log("the download is shown as the browser reports it, and never before");
{
  const created = gate();
  const summarizer = heldStub();
  const model = browser("downloadable", async () => {
    await created.waited;
    return summarizer;
  });
  const { panel, controls } = mount({ source: model.source });
  await panel.settled();
  controls.open.click();
  while (model.creates() === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  assert("a create in flight has not yet claimed a download is happening", panel.stage().kind !== "downloading");
  model.report(0.4);
  const stage = panel.stage();
  assert("the browser's first report is what says one is", stage.kind === "downloading" && stage.loaded === 0.4);
  assert("the bar shows that number", !controls.progress.hidden && controls.progress.value === 0.4);
  assert("and the button is out of the way while it downloads", controls.open.hidden);
  model.report(1);
  assert("later reports move it", (panel.stage() as { loaded: number }).loaded === 1);
  created.open();
  await panel.settled();
  assert("when it is made, the whole affordance leaves the page", controls.root.hidden && panel.stage().kind === "working");
  panel.dispose();
}

console.log("a create the browser refuses is said out loud, with a way to try again");
{
  const model = browser("downloadable", refuses("Requires a user gesture"));
  const { panel, controls, digests } = mount({ source: model.source });
  await panel.settled();
  controls.open.click();
  await panel.settled();
  const stage = panel.stage();
  assert("the ask stands, carrying the reason", stage.kind === "ask" && stage.refusal === "Requires a user gesture");
  assert("the reader can read it", controls.note.textContent?.includes("Requires a user gesture") === true);
  assert("the button invites another try", controls.open.textContent === RETRY_LABEL && !controls.open.hidden);
  assert("no turn claims a digest it does not have", digests().length === 0);
  assert("and the bar is not left mid-download", controls.progress.hidden);
  panel.dispose();
}

console.log("a monitor outliving the create it was handed to cannot claim a download");
{
  const model = browser("downloadable", refuses("Requires a user gesture"));
  const { panel, controls } = mount({ source: model.source });
  await panel.settled();
  controls.open.click();
  await panel.settled();
  assert("the refusal stands", panel.stage().kind === "ask");
  // The browser refused, but the EventTarget it was handed is still there and still ours.
  model.report(0.5);
  assert("a report on it moves nothing", panel.stage().kind === "ask");
  assert("and leaves no bar behind", controls.progress.hidden);
  panel.dispose();
}

console.log("a digest for a turn the page never drew is the PAGE's bug, not the browser's");
{
  // The service's indices and the renderer's are the same indices; where they are not, that
  // is a broken invariant between the two and digestView.ts raises it rather than skipping
  // the turn. The panel must not dress that up as a summarizer the browser refused —
  // a create that in fact SUCCEEDED, reported to the reader as a failure, with a button
  // inviting them to open a second model on top of the one already running.
  const model = browser("available", ready());
  const { panel, controls, faults, digests } = mount({
    source: model.source,
    turns: [...DIGEST_TURNS, { index: 99, input: DIGEST_TURNS[0]!.input }],
  });
  await panel.settled();
  assert("what actually went wrong is said where it can be read", faults.some((what) => what.includes("digests could not be put")));
  assert("the reader is told nothing about a summarizer that did not fail", controls.note.textContent?.includes("could not start") !== true);
  assert("the panel stays out of the reader's way rather than falling back to the ask", panel.stage().kind === "working" && controls.root.hidden);
  assert("one summarizer was opened", model.creates() === 1);
  // The point of starting the walk before the first painting: the broken turn is the only
  // one the reader loses. Painting first meant the throw arrived before the walk began and
  // NO turn was ever digested, with the ask already hidden and no retry able to reach it.
  const written = digests();
  assert("every turn the page did draw still gets its digest", written.length === 3);
  assert("and they carry real digests, not a stalled Summarizing…", written.every((text) => text.includes("digest of")));
  // The ask is hidden, but the button is still in the page and still clickable.
  controls.open.click();
  await panel.settled();
  assert("and a tap cannot open a second one beside it", model.creates() === 1);
  panel.dispose();
  assert("the one model is let go", model.held()?.destroyed() === true);
}

console.log("a create that fails where the reader was never asked still tells them");
{
  const model = browser("available", refuses("the model would not load"));
  const { panel, controls } = mount({ source: model.source });
  await panel.settled();
  assert("the ask appears rather than the feature vanishing silently", !controls.root.hidden && panel.stage().kind === "ask");
  assert("carrying the reason", controls.note.textContent?.includes("the model would not load") === true);
  panel.dispose();
}

// ── the remembered yes ───────────────────────────────────────────────────────────────

console.log("a remembered yes is not asked again: the reader's next gesture is the tap");
{
  const model = browser("downloadable", refuses("Requires a user gesture"));
  const { panel, controls, window, digests } = mount({ source: model.source, remembered: true });
  await panel.settled();
  assert("it tried without being asked", model.creates() === 1);
  assert("the ask stands meanwhile, so a reader who never gestures still sees what is on offer", !controls.root.hidden);
  // The reader clicks anywhere at all — the browser's activation is what was missing.
  window.dispatchEvent(new window.Event("pointerdown"));
  await panel.settled();
  assert("the gesture was taken as the tap", model.creates() === 2);
  assert("still refused, so the ask still stands", panel.stage().kind === "ask");
  assert("and no digests were claimed", digests().length === 0);
  panel.dispose();
}

console.log("the gesture is taken once, not on every click the reader ever makes");
{
  let answers = 0;
  const summarizer = heldStub();
  const model = browser("downloadable", async () => {
    answers += 1;
    if (answers === 1) throw new Error("Requires a user gesture");
    return summarizer;
  });
  const { panel, window, digests } = mount({ source: model.source, remembered: true });
  await panel.settled();
  window.dispatchEvent(new window.Event("pointerdown"));
  await panel.settled();
  assert("the second attempt succeeded", model.creates() === 2 && digests().length === 3);
  window.dispatchEvent(new window.Event("pointerdown"));
  window.dispatchEvent(new window.Event("keydown"));
  await panel.settled();
  assert("and further gestures create nothing more", model.creates() === 2);
  panel.dispose();
}

console.log("unticking the box withdraws the yes — the gesture that withdraws it is not the tap");
{
  // The reader remembered a yes, the create was refused for want of activation, and their
  // next gesture anywhere stands in for the tap. They then change their mind and untick the
  // box. Its pointerdown reaches the window BEFORE the change event that records the
  // withdrawal, so a panel that took any gesture at all would start the very download the
  // reader was in the act of refusing.
  const model = browser("downloadable", refuses("Requires a user gesture"));
  const { panel, controls, store, window } = mount({ source: model.source, remembered: true });
  await panel.settled();
  assert("it tried once on the remembered yes", model.creates() === 1);
  assert("and the box is ticked, as the device remembers it", controls.always.checked);
  // Exactly what a browser sends when the reader clicks the checkbox, in that order.
  controls.always.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  controls.always.checked = false;
  controls.always.dispatchEvent(new window.Event("change"));
  await panel.settled();
  assert("no download was started by the act of refusing one", model.creates() === 1);
  assert("the device no longer remembers a yes", readPreference(store) === false);
  // And the withdrawal holds: a later gesture elsewhere does not resurrect the standing yes.
  window.dispatchEvent(new window.Event("pointerdown"));
  await panel.settled();
  assert("nor does any gesture after it", model.creates() === 1);
  assert("the ask still stands, so the reader can still say yes deliberately", !controls.root.hidden);
  controls.open.click();
  await panel.settled();
  assert("and the button still means yes", model.creates() === 2);
  panel.dispose();
}

console.log("a remembered yes buys one gesture-backed try, not one create per keystroke");
{
  // A browser that refuses every create — the model fetch blocked, no room on the device —
  // with a remembered yes behind it. The yes exists to supply the user activation a quiet
  // page load cannot have; once a real gesture has been behind a create and it failed
  // anyway, a second gesture cannot fix it, and re-arming on every refusal would hand a
  // reader typing in the page's search box one Summarizer.create() per keystroke.
  const model = browser("downloadable", refuses("the model would not load"));
  const { panel, controls, window } = mount({ source: model.source, remembered: true });
  await panel.settled();
  assert("it tried once on the remembered yes", model.creates() === 1);
  window.dispatchEvent(new window.Event("pointerdown"));
  await panel.settled();
  assert("the reader's gesture was taken as the tap", model.creates() === 2);
  for (let keystroke = 0; keystroke < 8; keystroke += 1) window.dispatchEvent(new window.Event("keydown"));
  await panel.settled();
  assert("and typing afterwards starts nothing at all", model.creates() === 2);
  assert("the ask stands, carrying the reason", panel.stage().kind === "ask");
  assert("the reader can read it", controls.note.textContent?.includes("the model would not load") === true);
  controls.open.click();
  await panel.settled();
  assert("the button is still the deliberate way to try again", model.creates() === 3);
  panel.dispose();
}

console.log("a remembered yes on a metered connection asks anyway");
{
  const model = browser("downloadable", ready());
  const { panel, controls } = mount({ source: model.source, remembered: true, connection: { type: "cellular" } });
  await panel.settled();
  assert("nothing was attempted", model.creates() === 0);
  assert("the reader is asked", !controls.root.hidden && panel.stage().kind === "ask");
  assert("as if for the first time — the refusal line is for refusals", controls.open.textContent === ASK_LABEL);
  panel.dispose();
}

console.log("the box the reader ticks is the preference itself");
{
  const model = browser("downloadable", ready());
  const { panel, controls, store } = mount({ source: model.source });
  await panel.settled();
  assert("it starts unticked on a device that remembers nothing", !controls.always.checked);
  controls.always.checked = true;
  controls.always.dispatchEvent(new (controls.always.ownerDocument.defaultView as Window & typeof globalThis).Event("change"));
  assert("ticking it writes the device's yes", store.getItem(PREFERENCE_KEY) !== null);
  controls.always.checked = false;
  controls.always.dispatchEvent(new (controls.always.ownerDocument.defaultView as Window & typeof globalThis).Event("change"));
  assert("unticking removes it rather than writing a second value", store.getItem(PREFERENCE_KEY) === null);
  panel.dispose();
}

console.log("a device that already remembers meets the box already ticked");
{
  const model = browser("downloadable", ready());
  const { panel, controls } = mount({ source: model.source, remembered: true, connection: { type: "cellular" } });
  await panel.settled();
  assert("ticked, so the reader can see and undo what they told this device", controls.always.checked);
  panel.dispose();
}

// ── the reader moving, and leaving ───────────────────────────────────────────────────

console.log("the walk aims where the reader is");
{
  const order: string[] = [];
  const summarizer = heldStub();
  const model = browser("available", async () => ({
    ...summarizer,
    summarize: async (input: string) => {
      order.push(input.split(/\s+/)[0] ?? "");
      return summarizer.summarize(input);
    },
  }));
  const { panel } = mount({ source: model.source });
  panel.readAt(2);
  await panel.settled();
  assert("the turn the reader is at is digested first", order[0] === "c0");
  assert("then the rest, wrapping to the start", order.join() === "c0,a0,b0");
  panel.dispose();
}

console.log("leaving the page stops the walk and lets the model go");
{
  const gate: Array<() => void> = [];
  const summarizer = heldStub();
  const model = browser("available", async () => ({
    ...summarizer,
    summarize: async (input: string) => {
      await new Promise<void>((resolve) => gate.push(resolve));
      return summarizer.summarize(input);
    },
  }));
  const { panel, digests } = mount({ source: model.source });
  while (gate.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  panel.dispose();
  for (const open of gate) open();
  await panel.settled();
  assert("the turn in flight settles nothing onto the page", digests().every((text) => text.includes("Summarizing")));
  assert("the summarizer was let go", model.held()?.destroyed() === true);
  panel.dispose();
  assert("disposing twice is not an error", true);
}

console.log(process.exitCode === 1 ? "digest-panel-check: FAILED" : "digest-panel-check: ok");
