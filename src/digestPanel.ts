// [LAW:decomposition] The page's digests brought to life: the one place that asks the
// browser what it can do, asks the reader when the browser needs a tap, and keeps the walk
// aimed where the reader is. One sentence with a rhythm, not three jobs — every step here
// is the same step, "get a summarizer and keep it working", and each piece it uses is
// elsewhere: the browser's answer is summarizerSource.ts's, the remembered yes is
// digestConsent.ts's, the deriving is turnDigest.ts's, and what a turn shows is
// digestView.ts's.
//
// [LAW:types-are-the-program] The five states the reader can be in collapse to four, because
// a refusal is an ask that carries a reason — there is no separate failed face with its own
// button, and no state where the page is downloading without a number to show. `working` and
// `unavailable` both show NOTHING: a browser that cannot summarize offers no affordance at
// all, and one that is summarizing lets the turns speak for themselves.
//
// THE BROWSER'S GATE, AND WHY THE REMEMBERED YES IS NOT A LIE. create() consumes transient
// user activation whenever it must download, so no preference can start that download on a
// quiet page load. Rather than predict activation — which nothing exposes — the panel
// ATTEMPTS and reads the browser's answer [LAW:dataflow-not-control-flow]: a reader who
// remembered their yes is never asked again, their next gesture anywhere on the page is
// taken as the tap, and the ask stands meanwhile so a reader who never gestures still sees
// what is on offer rather than a feature that silently never happens.
//
// [LAW:effects-at-boundaries] Every edge is a parameter: the global, the device's storage,
// the connection reading, the elements, and where gestures arrive. scripts/digest-panel-check.ts
// drives all four stages under jsdom with a browser that has no API, one that downloads, one
// that refuses and one that is ready.

import { readPreference, standingConsent, writePreference, type StandingConsent } from "./digestConsent";
import { createDigestView } from "./digestView";
import type { ConnectionReading } from "./modelAssets";
import type { PreferenceStore } from "./preferenceStore";
import {
  DIGEST_OPTIONS,
  NATIVE_IMPLEMENTATION,
  availabilityOf,
  openSummarizer,
  summarizerIdentity,
  type HeldSummarizer,
  type SummarizerAvailability,
  type SummarizerOptions,
  type SummarizerSource,
} from "./summarizerSource";
import { createDigestService, preferenceDigestStore, type DigestService, type DigestTurn } from "./turnDigest";

// ── the pure part ──────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] What the page does about getting a summarizer, before anything
// is attempted: nothing at all, try now, or ask. A remembered yes is NOT a fourth answer —
// it is precisely what turns an ask into a try, which is the whole of what remembering buys.
// Naming it separately would be a distinction the type asserts and the program never makes;
// what a refusal then costs the reader is carried by the preference itself, read where the
// arming decision is [LAW:one-source-of-truth].
export type DigestOpening = "none" | "attempt" | "ask";

// [LAW:dataflow-not-control-flow] One table, no branching on the reader's history: what the
// browser says about the model crossed with what the device remembers. `downloading` — the
// model is already coming down for another page — is the same case as `downloadable` here:
// create() still needs the activation, and the progress the reader then sees is the download
// already under way.
export const openingOf = (availability: SummarizerAvailability, consent: StandingConsent): DigestOpening => {
  switch (availability) {
    case "unavailable":
      return "none";
    case "available":
      return "attempt";
    case "downloadable":
    case "downloading":
      return consent === "download" ? "attempt" : "ask";
  }
};

// [LAW:types-are-the-program] The page's one digest affordance, total. `ask` carries the
// reason a previous attempt failed, or null when nothing has been tried — so "asking" and
// "asking again after a refusal" are one state with one button, not two faces to keep in
// step. `downloading` cannot exist without the number it shows.
export type DigestStage =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ask"; readonly refusal: string | null }
  | { readonly kind: "downloading"; readonly loaded: number }
  | { readonly kind: "working" };

// The sentence the ask shows before anything has been tried. It does not name a size: the
// spec gives none and Chrome reports none, and inventing one would be the first thing a
// reader could catch the page lying about [LAW:no-silent-failure].
export const ASK_NOTE =
  "Each long turn gets a short digest at its head, summarized by your browser on this device. Nothing is sent anywhere. Your browser downloads its summary model the first time, and does not say how large it is.";
export const ASK_LABEL = "Summarize each turn";
export const RETRY_LABEL = "Try again";
export const DOWNLOADING_NOTE = "Downloading your browser's summary model…";

// ── the driver ─────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] Exactly the elements the panel writes, so the page hands it
// these and the check builds these. Visibility has ONE authority — the `hidden` attribute,
// written by `show` for every part on every stage — and the panel marks them with nothing
// else. It used to also stamp a `data-stage` "for the stylesheet", which no rule ever read:
// a second account of "is the reader being asked" that could only ever drift from the first
// [LAW:one-source-of-truth]. (`data-digest`, which the stylesheet does read, is the VIEW's
// attribute on a turn's own digest, and is a different thing.)
export interface DigestControls {
  readonly root: HTMLElement;
  readonly open: HTMLButtonElement;
  readonly always: HTMLInputElement;
  readonly note: HTMLElement;
  readonly progress: HTMLProgressElement;
}

export interface DigestPanelConfig {
  readonly controls: DigestControls;
  readonly conversation: HTMLElement;
  // The turns to digest, each with the text already selected: digestTurnsOf, run once on the
  // server where the derived model lives. The browser re-derives nothing from rendered HTML.
  readonly turns: ReadonlyArray<DigestTurn>;
  // The browser's Summarizer, or null where there is none — summarizerSource(self).
  readonly source: SummarizerSource | null;
  // The device's storage: the remembered yes and the kept digests share it.
  readonly store: PreferenceStore;
  readonly connection: ConnectionReading | undefined;
  // Where the reader's gestures arrive (the window), for the remembered yes.
  readonly gestures: EventTarget;
  readonly options?: SummarizerOptions;
  readonly implementation?: string;
  // Said in the console where the page's own view throws — its listeners are this panel's.
  readonly onFault?: (what: string, error: unknown) => void;
}

export interface DigestPanel {
  readonly stage: () => DigestStage;
  // Resolves when the panel has nothing in flight: it has asked the browser what it can do,
  // any attempt it made has settled, and the walk has derived every turn it can. An honest
  // fact about the panel rather than a seam for the check — Listen's narrator (the sibling
  // ticket) waits on exactly this before it can say a digest — and the reason
  // scripts/digest-panel-check.ts never counts microtasks to know when to look
  // [LAW:no-ambient-temporal-coupling].
  readonly settled: () => Promise<void>;
  // The reader is at this turn: the walk re-aims, so what they are about to read is derived
  // before what they have passed.
  readonly readAt: (index: number) => void;
  // The page is leaving: the walk stops, the model is let go, and nothing settles after.
  readonly dispose: () => void;
}

export const createDigestPanel = (config: DigestPanelConfig): DigestPanel => {
  const { controls, conversation, turns, source, store, connection, gestures } = config;
  const options = config.options ?? DIGEST_OPTIONS;
  const implementation = config.implementation ?? NATIVE_IMPLEMENTATION;
  const fault = config.onFault ?? ((what, error) => console.warn(`digests: ${what}`, error));
  const view = createDigestView(conversation);

  // [LAW:no-shared-mutable-globals] Owned here: the stage is written only through `show`,
  // the summarizer and service only by `attempt`, and `at` only by `readAt`.
  let stage: DigestStage = { kind: "unavailable" };
  let held: HeldSummarizer | null = null;
  let service: DigestService | null = null;
  let attempting = false;
  // Which attempt is the live one. A create's monitor OUTLIVES the create: a browser that
  // refuses for want of a gesture leaves the EventTarget it was handed, and anything still
  // reporting on it would otherwise put the page back into a download nobody is doing.
  let attemptNo = 0;
  let armed: (() => void) | null = null;
  // Whether the remembered yes has already spent its one gesture — see the create's catch.
  let armSpent = false;
  // The walk this panel is already tracking. A walk that ends is never this again — the
  // service answers a later start with a new promise — so it needs no clearing.
  let walking: Promise<void> | null = null;
  let at = 0;
  let gone = false;
  // Everything the panel has in flight, folded into one promise. `allSettled` because a
  // refusal is an outcome the panel has already answered for, never a reason for a waiter to
  // reject [LAW:no-silent-failure].
  let work: Promise<unknown> = Promise.resolve();
  // [LAW:single-enforcer] The one way the panel starts anything: the job joins the fold
  // `settled()` waits on, and whatever it throws is SAID. Because there is no other way to
  // start work, there is no way to start work that a waiter cannot see or that fails into an
  // unhandled rejection where nobody reads it [LAW:no-silent-failure].
  const run = (what: string, job: Promise<unknown>): void => {
    work = Promise.allSettled([work, job]);
    job.catch((error: unknown) => fault(what, error));
  };

  // [LAW:dataflow-not-control-flow] One writer for the whole affordance: every stage sets
  // every part, so no part can carry a sentence left over from the stage before.
  const show = (next: DigestStage): void => {
    stage = next;
    controls.root.hidden = next.kind === "unavailable" || next.kind === "working";
    controls.open.hidden = next.kind !== "ask";
    controls.progress.hidden = next.kind !== "downloading";
    if (next.kind === "ask") {
      controls.open.textContent = next.refusal === null ? ASK_LABEL : RETRY_LABEL;
      controls.note.textContent = next.refusal === null ? ASK_NOTE : `The summarizer could not start: ${next.refusal}`;
    }
    if (next.kind === "downloading") {
      controls.note.textContent = DOWNLOADING_NOTE;
      controls.progress.value = next.loaded;
    }
  };

  // Every turn's outcome as the service already holds it, written at once: a short turn
  // erases nothing because it never had an element, and a long one says it is pending before
  // the first summarize call returns, so the reader sees what is coming [LAW:no-silent-failure].
  const paint = (live: DigestService): void => {
    for (const { index } of turns) view.write(index, live.outcome(index));
  };

  // One owner for "an attempt is under way": the guard against a second attempt and the
  // button's own disabled state are the same fact, so they are written together and the
  // button can never invite a tap the panel would drop [LAW:one-source-of-truth].
  const attemptingNow = (busy: boolean): void => {
    attempting = busy;
    controls.open.disabled = busy;
  };

  // The walk is started, never queued behind what is already in flight: a start while a walk
  // is live RE-AIMS it, which is the whole point of the reader moving, and a queued start
  // would arrive only once the walk it meant to redirect had finished.
  const walk = (live: DigestService): void => {
    const job = live.start(at);
    // A start while a walk is under way RE-AIMS it and answers with the walk already
    // running, so the reader scrolling a long paste asks for the same promise over and over.
    // Tracking it each time would hang another link on the fold `settled()` waits for and
    // another catch on the one job — a hundred scroll steps, a hundred copies of one
    // listener's throw in the console [LAW:one-source-of-truth].
    if (job === walking) return;
    walking = job;
    run("a digest listener threw", job);
  };

  // The reader's next gesture stands in for the tap the browser wants. One shot: it is
  // disarmed as it fires, and again on dispose, so a page the reader left holds no listener.
  const disarm = (): void => {
    armed?.();
    armed = null;
  };

  const GESTURES = ["pointerdown", "keydown"];

  const arm = (): void => {
    if (armed !== null) return;
    const take = (): void => {
      disarm();
      // The device's yes is read HERE rather than captured when this was armed: it is the
      // one authority on whether the reader still wants this, and an arm outliving the yes
      // it stands for would act on a withdrawn consent [LAW:one-source-of-truth].
      if (!readPreference(store)) return;
      run("the digests could not be put on their turns", attempt());
    };
    // A gesture on the ask ITSELF is never the stand-in tap. Every control there already
    // means something exact — the button IS the tap, and the box is the reader changing
    // their mind — and the box's `pointerdown` arrives BEFORE the `change` that records the
    // withdrawal, so a window listener alone would read a reader UNTICKING the box as their
    // consent to download and start the very download they were refusing. These listeners
    // sit nearer the target and so run first, taking the arm down without attempting
    // anything; the reader who wants it has a button that says so.
    for (const kind of GESTURES) controls.root.addEventListener(kind, disarm);
    for (const kind of GESTURES) gestures.addEventListener(kind, take);
    armed = () => {
      for (const kind of GESTURES) controls.root.removeEventListener(kind, disarm);
      for (const kind of GESTURES) gestures.removeEventListener(kind, take);
    };
  };

  // [LAW:no-silent-failure] One attempt, whatever asked for it — the button, the remembered
  // yes's gesture, or an availability that needed no asking. Whatever the browser refuses
  // with becomes the reason the ask then shows; a reader who remembered their yes is not
  // asked again but is told, and their next gesture tries once more.
  const attempt = async (): Promise<void> => {
    // [LAW:one-source-of-truth] A panel opens ONE summarizer, ever: `held` is that fact, so
    // a second attempt cannot orphan the first model, subscribe the view twice, or leave two
    // services walking the same turns.
    if (attempting || gone || held !== null || source === null) return;
    attemptingNow(true);
    const mine = (attemptNo += 1);
    // The stage is NOT moved to `downloading` here: a create that needs no download never
    // reports progress, and a page that announced a download it is not doing would be
    // lying for however long the create takes [LAW:no-silent-failure]. The monitor's first
    // report is what says a download is happening, and it is the only thing that says it.
    let summarizer: HeldSummarizer;
    // NO abort signal, deliberately, though openSummarizer takes one. The model is the
    // BROWSER's and is shared across every page that wants it — that is why a second visit
    // finds it `available` — so a reader who leaves mid-download has started something worth
    // finishing, and aborting it would make them start over next time. What this page holds
    // is let go instead: a summarizer that resolves after the reader is gone is destroyed
    // below rather than kept.
    // [LAW:no-silent-failure] This try answers for the BROWSER's refusal and nothing else.
    // Everything below it is the page's own work, and the one thing that throws there —
    // a turn the renderer never drew, which digestView.ts raises rather than skipping — is a
    // broken invariant between the render and the service. Under a wider try it would reach
    // the reader as "the summarizer could not start: the conversation has no turn 7", blaming
    // the browser for the page's bug and inviting a retry that opens a SECOND model.
    try {
      summarizer = await openSummarizer(source, options, (loaded) => {
        // Only the attempt still in flight may say a download is happening [LAW:no-silent-failure].
        if (!gone && attempting && mine === attemptNo) show({ kind: "downloading", loaded });
      });
    } catch (error) {
      // A page the reader has already left is told nothing and arms nothing: `dispose` said
      // this panel holds no listener, and a create the browser abandons on unload is the
      // ordinary way to arrive here.
      if (gone) return;
      const refusal = error instanceof Error ? error.message : String(error);
      show({ kind: "ask", refusal });
      // The remembered yes buys ONE gesture-backed try, not a standing retry. Its whole job
      // is to supply the user activation a quiet page load cannot have; once a real gesture
      // has been behind a create and it failed anyway, it failed for something a second
      // gesture cannot fix. Re-arming on every refusal would hand a reader who is typing in
      // the page's search box one Summarizer.create() per keystroke. The ask stands with its
      // button, which is the deliberate way to try again.
      if (!armSpent && readPreference(store)) {
        armSpent = true;
        arm();
      }
      return;
    } finally {
      attemptingNow(false);
    }
    if (gone) {
      summarizer.destroy();
      return;
    }
    held = summarizer;
    const live = createDigestService({
      turns,
      summarizer,
      identity: summarizerIdentity(options, implementation),
      store: preferenceDigestStore(store),
    });
    service = live;
    live.subscribe((index, outcome) => view.write(index, outcome));
    show({ kind: "working" });
    // The walk is started BEFORE the first painting, and the order is the whole difference
    // between one turn missing its digest and the feature being off. `paint` writes every
    // turn at once and `view.write` throws on a turn the renderer never drew, so painting
    // first meant one bad index took all the others down with it — attempt rejected before
    // the walk ever began, the ask already hidden, and `held` already set so no retry could
    // reach it. Started first, the walk derives every turn it can and the service collects
    // what the bad one throws; the reader loses exactly the turn that is broken
    // [LAW:no-silent-failure].
    walk(live);
    paint(live);
  };

  // [LAW:no-silent-failure] Whatever the browser answers about availability decides what the
  // reader is offered; an availability call that throws is a browser whose API this build
  // does not understand, and the honest reading of that is no affordance at all.
  const open = async (): Promise<void> => {
    if (source === null) return;
    const availability = await availabilityOf(source, options).catch((error: unknown) => {
      fault("the browser would not say whether it can summarize", error);
      return "unavailable" as const;
    });
    if (gone) return;
    switch (openingOf(availability, standingConsent(readPreference(store), connection))) {
      case "none":
        show({ kind: "unavailable" });
        return;
      case "attempt":
        // Whether this is a model already on the device or a remembered yes being honoured,
        // the page does the same thing and finds out the same way. If the browser refuses —
        // for want of a gesture, or anything else — `attempt` has already shown the ask with
        // the reason, and armed the reader's next gesture where a yes was remembered.
        await attempt();
        return;
      case "ask":
        show({ kind: "ask", refusal: null });
        return;
    }
  };

  controls.open.addEventListener("click", () => run("the digests could not be put on their turns", attempt()));
  controls.always.addEventListener("change", () => writePreference(store, controls.always.checked));
  controls.always.checked = readPreference(store);
  show({ kind: "unavailable" });
  // The same sentence as the button's and the gesture's: an availability that throws is
  // already answered for inside `open`, so the only thing left for this to catch is what
  // `attempt` throws — one failure, said one way, however the reader arrived at it
  // [LAW:one-source-of-truth].
  run("the digests could not be put on their turns", open());

  return {
    stage: () => stage,
    // [LAW:no-ambient-temporal-coupling] Waiting until the fold stops growing, rather than
    // awaiting it once: the walk this await is for adds the next turn's derivation while the
    // waiter is already suspended on the last one.
    settled: async () => {
      for (let seen = work; ; seen = work) {
        await work;
        if (work === seen) return;
      }
    },
    readAt: (index) => {
      at = index;
      if (service !== null) walk(service);
    },
    dispose: () => {
      gone = true;
      disarm();
      service?.stop();
      service = null;
      held?.destroy();
      held = null;
    },
  };
};
