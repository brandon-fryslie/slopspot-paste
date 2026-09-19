// [LAW:decomposition] The voice picker's markup: a row per picked role listing the voices by
// name, a button to hear each, the credit one hover away, a reset, and the reader's own
// voices — the ones they recorded, and the form that records one more. One sentence, no
// "and": this module draws the picker and reports the reader's taps. It decides nothing —
// which voices exist is the manifest's and the device's (clonedVoice.ts), what a tap means
// and whether it plays the voice itself or its sample is the panel's (listenPanel.ts) — and
// holds no state: every render writes every attribute from the readout it is handed, so no
// path leaves a stale check, a stale note or a stale sounding mark behind
// [LAW:dataflow-not-control-flow].
//
// BUILT, NOT TEMPLATED. The rows are the product of two lists — the picked roles and the
// voices — and the credit beside each name is the manifest's, so the page carries an empty
// block and the rows are built here from the data the voice map is derived from
// [LAW:one-source-of-truth]: a seventh hosted voice is a seventh option with no template
// edit, and the check under jsdom meets the same rows the page does. The hosted options
// are built once; a clone's options are built when the readout first names it and removed
// when it stops, so the rows are always exactly the voices the device has.
//
// THE CREDIT. The CC-BY voices require attribution; each name carries its voice's
// attribution and licence as its title, so the credit is one hover (or one long press)
// away without a line of chrome per voice. A clone's title says it is the reader's own.
//
// WHAT IT SOUNDS LIKE. The name is not a description, so each voice carries one beneath it
// (voiceChoice.voiceDescription) — shown, not hovered, because it is the thing a reader
// chooses by. It is the radio's `aria-describedby`, so the option announces as its name
// and then what it sounds like, rather than as one long name.
//
// THE FORM. Under the rows: the passage to read (clonePassage.ts), a name, a Record button
// that becomes Stop while the microphone is open, an Upload that takes a file, and a line that
// says where the making is. A clone is removed from its own row's ✕, once per picker, not per
// role.
//
// THE PASSAGE IS NOT OPTIONAL CHROME. A reader left to improvise ten seconds says whatever
// comes to mind, and the clone can only ever say sounds the recording held — so the passage is
// the difference between cloning a voice and cloning the corner of it that got practised. It
// is shown always rather than only while recording, because it is read *before* the tap, and
// it is the Record button's `aria-describedby` so reaching the button by keyboard is hearing
// what to read.

import { CLONE_PASSAGE } from "./clonePassage";
import { CLONE_SECONDS, NAME_LENGTH, isClonedKey, type ClonedVoice, type ClonedVoiceKey, type VoiceKey } from "./clonedVoice";
import { MODEL_ASSETS, VOICE_IDS, type VoiceId } from "./modelAssets";
import { RECORDING_SECONDS } from "./voiceCapture";
import { CLONE_CREDIT, PICKED_VOICES, ROLE_LABELS, voiceDescription, voiceName, type PickedVoice, type VoicePick } from "./voiceChoice";
import type { CloningState } from "./voiceCloning";

// [LAW:types-are-the-program] How a voice is heard out: live, its phrase made by the model
// on this device, or from its sample (voiceSample.ts), with the note beside the rows that
// says so. A voice can always be heard; the note is what changes.
export type Audition = { readonly kind: "live" } | { readonly kind: "sample"; readonly note: string };

// What the picker shows: the pick, how a voice is heard out, the voice sounding now, whether
// there is anything to reset, the clones the device keeps and where the making of one is.
// Declared here, filled by the panel's readout.
export interface VoicesReadout {
  readonly picked: VoicePick;
  readonly audition: Audition;
  readonly sounding: VoiceKey | null;
  readonly reset: boolean;
  readonly cloned: ReadonlyArray<ClonedVoice>;
  readonly cloning: CloningState;
}

export interface VoicePickerHandlers {
  readonly pick: (role: PickedVoice, voice: VoiceKey) => void;
  readonly preview: (voice: VoiceKey) => void;
  readonly reset: () => void;
  // The form's taps: a recording under the name, a file under the name, the stop.
  readonly record: (name: string) => void;
  readonly upload: (name: string, file: Blob) => void;
  readonly stop: () => void;
  readonly remove: (key: ClonedVoiceKey) => void;
}

export interface VoicePicker {
  readonly render: (shown: VoicesReadout) => void;
}

export const voiceCredit = (id: VoiceId): string => {
  const asset = MODEL_ASSETS.voices[id];
  return `${asset.attribution} · ${asset.licence}`;
};

// [LAW:one-source-of-truth] The button names the ACTION and no duration, because there are two now
// and it was quietly claiming to be both. It used to be literally the cap; since the microphone runs
// to RECORDING_SECONDS so that CLONE_SECONDS of voice can fit, "Record 10 s" understated how long it
// stays open while also being the only number a reader saw. The kept length is stated in the
// instruction that explains it, and the cap in the note for the recording actually under way — one
// number in each place, each beside the thing it describes.
export const RECORD_LABEL = "● Record";
export const STOP_LABEL = "■ Stop";
export const MAKING_NOTE = "Making the voice…";

interface Option {
  readonly role: PickedVoice;
  readonly voice: VoiceKey;
  readonly cell: HTMLElement;
  readonly radio: HTMLInputElement;
  readonly preview: HTMLButtonElement;
}

// [LAW:one-source-of-truth] The one name every id and every radio group of this picker is
// built from. A document resolves a `for` to the first id that matches and groups radios by
// name across the whole page, so two pickers sharing a namespace would leave the second
// one's names checking the first one's radios and its picks silently unchecking the first
// one's rows. The page's own id is the namespace where there is one — it is readable, it is
// stable across renders, and the page already keeps it unique. Where there is none the
// document is asked for a name it does not yet hold, so mounting a picker anywhere is a
// picker with its own group and no setup asked of the caller [LAW:composability].
const namespaceOf = (root: HTMLElement): string => {
  if (root.id !== "") return root.id;
  const doc = root.ownerDocument;
  let nth = 1;
  while (doc.getElementById(`voice-picker-${nth}`) !== null) nth += 1;
  root.id = `voice-picker-${nth}`;
  return root.id;
};

// A clone's key as the fragment of an element id: the hash after the prefix.
const idOf = (voice: VoiceKey): string => voice.replace(":", "-");

interface Built {
  readonly hosted: ReadonlyArray<Option>;
  readonly rows: Readonly<Record<PickedVoice, HTMLElement>>;
  readonly note: HTMLElement;
  readonly reset: HTMLButtonElement;
  readonly clones: HTMLElement;
  readonly read: HTMLElement;
  readonly passage: HTMLElement;
  readonly name: HTMLInputElement;
  readonly record: HTMLButtonElement;
  readonly upload: HTMLButtonElement;
  readonly file: HTMLInputElement;
  readonly making: HTMLElement;
  readonly option: (role: PickedVoice, voice: VoiceKey, cloned: ReadonlyArray<ClonedVoice>) => Option;
  readonly cloneRow: (voice: ClonedVoice) => HTMLElement;
}

const build = (root: HTMLElement, on: VoicePickerHandlers): Built => {
  const doc = root.ownerDocument;
  const scope = namespaceOf(root);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    made.className = className;
    return made;
  };
  // appendChild, not append: under the page's build the Workers runtime types shadow the
  // DOM's Element with HTMLRewriter's, whose `append` takes a string.
  const attach = (parent: HTMLElement, ...children: ReadonlyArray<HTMLElement>): void => {
    for (const child of children) parent.appendChild(child);
  };
  const option = (role: PickedVoice, voice: VoiceKey, cloned: ReadonlyArray<ClonedVoice>): Option => {
    const name = voiceName(voice, cloned);
    const radio = el("input", "voice-radio");
    radio.type = "radio";
    radio.id = `${scope}-radio-${role}-${idOf(voice)}`;
    radio.name = `${scope}-voice-${role}`;
    radio.value = voice;
    radio.addEventListener("change", () => {
      if (radio.checked) on.pick(role, voice);
    });
    // The name is the radio's label rather than its wrapper, so the radio is a cell of the
    // option's grid and the description below it starts in the name's column without a
    // measured indent; tapping the name still picks the voice, which is what `for` means.
    const label = el("label", "voice-label");
    label.htmlFor = radio.id;
    label.title = isClonedKey(voice) ? CLONE_CREDIT : voiceCredit(voice);
    label.textContent = name;
    const preview = el("button", "voice-preview");
    preview.type = "button";
    preview.setAttribute("aria-label", `Hear ${name}`);
    preview.textContent = "▶";
    preview.addEventListener("click", () => on.preview(voice));
    const about = el("span", "voice-about");
    about.id = `${scope}-about-${role}-${idOf(voice)}`;
    about.textContent = voiceDescription(voice, cloned);
    radio.setAttribute("aria-describedby", about.id);
    const head = el("span", "voice-head");
    attach(head, label, preview);
    const cell = el("div", "voice-option");
    cell.dataset.voice = voice;
    attach(cell, radio, head, about);
    return { role, voice, cell, radio, preview };
  };
  const rows = {} as Record<PickedVoice, HTMLElement>;
  const hosted = PICKED_VOICES.flatMap((role) => {
    const row = el("fieldset", "voice-row");
    row.dataset.role = role;
    const legend = el("legend", "voice-role");
    legend.textContent = ROLE_LABELS[role];
    const built = VOICE_IDS.map((voice) => option(role, voice, []));
    attach(row, legend, ...built.map((o) => o.cell));
    attach(root, row);
    rows[role] = row;
    return built;
  });
  const note = el("p", "voice-note");
  const reset = el("button", "mono-pill voice-reset");
  reset.type = "button";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", on.reset);
  attach(root, note, reset);

  // The reader's own voices, and the form that makes one.
  // Not a `.voice-row`: the rows are the picked roles, and this is the reader's shelf.
  const own = el("fieldset", "voice-own");
  const ownLegend = el("legend", "voice-own-legend");
  ownLegend.textContent = "Your voices";
  const clones = el("div", "voice-clones");
  // [LAW:dataflow-not-control-flow] The passage stands in the form always — not only once the
  // microphone is open. A reader who has not tapped Record yet is exactly the reader who needs
  // to read it first, and a reader mid-recording has no time to start reading it. Written once
  // at build because it never varies, so `render` has no stale state to leave behind.
  const read = el("p", "voice-clone-read");
  read.id = `${scope}-clone-read`;
  // Both ways in get the same instruction: an uploaded recording of arbitrary speech is thin in
  // exactly the sounds it missed, the same as an improvised one, so naming only Record here
  // would leave the Upload path with the defect this passage exists to remove.
  //
  // AND BOTH ARE TOLD THE LENGTH, because both are cut to it. `clonePrompt` keeps CLONE_SAMPLES
  // of whatever it is handed, so a leisurely twenty-second take of this passage — an entirely
  // ordinary thing to record on a phone — still becomes ten seconds, and a reader who is not told
  // so clones a voice that never said `worth` or `mile`. NEITHER BUTTON CARRIES THE NUMBER — Record
  // names the action alone, because there are two durations now and one figure on a button claimed
  // to be both (RECORD_LABEL, asserted to hold no digit), and Upload never named one — so this
  // sentence is the only place either reader learns what is kept, and without it a form promising
  // "nothing goes missing" promised the opposite of what the code does [LAW:no-silent-failure].
  //
  // AND IT SAYS WHERE THE TEN SECONDS BEGIN, which is the reader's first word rather than the tap:
  // voiceCapture.ts records past its cap and takes the clone from where the voice begins
  // (slopspot-voices-4f5). This used to read "Start reading the moment you tap Record" — a request
  // standing in for a mechanism, because the lead-in was spent out of the same ten and nothing but
  // the reader's haste could save it [LAW:no-ambient-temporal-coupling].
  //
  // BUT IT NAMES THE BOUND, because the mechanism has one and the promise must not outrun it.
  // `speechStart` looks through LEAD_IN_SECONDS of silence and no further, so a first word later than
  // that gets a window clamped to the allowance's end and loses a second of reading for every second
  // more it took. "The ten seconds begin at your first word" read alone invites exactly that delay
  // [LAW:no-silent-failure].
  //
  // AND IT NAMES IT WITHOUT SAYING "TAP", because this same sentence describes Upload, where there is
  // no tap and no clock the reader controls — only a file whose own first seconds either hold their
  // first word or do not. "Start within a few seconds of tapping" was an instruction half the readers
  // of it could not act on, and a promise that was false for their file [LAW:one-type-per-behavior].
  read.textContent = `Read this aloud, or upload a recording of yourself reading it. The ${CLONE_SECONDS} seconds kept begin at your first word, as long as it comes in the first few seconds. These words cover every sound English makes:`;
  const passage = el("p", "voice-clone-passage");
  passage.id = `${scope}-clone-passage`;
  passage.textContent = CLONE_PASSAGE;
  const form = el("div", "voice-clone-form");
  const name = el("input", "voice-clone-name");
  name.type = "text";
  name.placeholder = "Name";
  name.maxLength = NAME_LENGTH;
  name.setAttribute("aria-label", "Name for the voice");
  const record = el("button", "mono-pill voice-clone-record");
  record.type = "button";
  // Its `aria-describedby` is written by `render`, not set once here: what usefully describes
  // this button is the words to read until there is a note, and the note from then on
  // [LAW:one-source-of-truth] — one writer for the attribute, the render.
  record.addEventListener("click", () => (record.dataset.recording === "true" ? on.stop() : on.record(name.value)));
  const upload = el("button", "mono-pill voice-clone-upload");
  upload.type = "button";
  upload.textContent = "Upload a recording";
  const file = el("input", "voice-clone-file");
  file.type = "file";
  file.accept = "audio/*";
  file.hidden = true;
  upload.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen !== undefined) on.upload(name.value, chosen);
    // The same file chosen again is a change again.
    file.value = "";
  });
  const making = el("p", "voice-note voice-clone-note");
  making.id = `${scope}-clone-note`;
  // [LAW:no-silent-failure] A status region, because this is where a failure lands. "Could not
  // make the voice: no microphone" arrives while focus is still on Record and nothing moves to
  // it, so without a live region the reason is written to a screen nobody is looking at — and a
  // reader using a screen reader is told only that the button says Record again.
  //
  // It is never `hidden`, and that is the whole point rather than an oversight. A region that is
  // `display: none` at the instant its text is written was not in the accessibility tree to be
  // watched, so the change goes unannounced — which is the very path this attribute was added
  // for. So it stands empty instead, costing one grid gap of blank space and buying the one
  // announcement that matters. `render` writes "" where it used to write `hidden`.
  making.setAttribute("role", "status");
  attach(form, name, record, upload, file);
  attach(own, ownLegend, clones, read, passage, form, making);
  attach(root, own);

  const cloneRow = (voice: ClonedVoice): HTMLElement => {
    const row = el("div", "voice-clone");
    row.dataset.voice = voice.key;
    const label = el("span", "voice-clone-label");
    label.textContent = voice.name;
    const remove = el("button", "voice-clone-remove");
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${voice.name}`);
    remove.addEventListener("click", () => on.remove(voice.key));
    attach(row, label, remove);
    return row;
  };

  return { hosted, rows, note, reset, clones, read, passage, name, record, upload, file, making, option, cloneRow };
};

export const mountVoicePicker = (root: HTMLElement, on: VoicePickerHandlers): VoicePicker => {
  const built = build(root, on);
  // [LAW:no-shared-mutable-globals] The clone options standing in the rows, owned here and
  // rebuilt by `render` alone whenever the readout's clones are not the ones standing.
  let cloneOptions: ReadonlyArray<Option> = [];
  let standing = "";
  const rebuild = (cloned: ReadonlyArray<ClonedVoice>): void => {
    const keys = cloned.map((voice) => `${voice.key} ${voice.name}`).join("");
    if (keys === standing) return;
    standing = keys;
    for (const option of cloneOptions) option.cell.parentNode?.removeChild(option.cell);
    while (built.clones.firstChild !== null) built.clones.removeChild(built.clones.firstChild);
    cloneOptions = PICKED_VOICES.flatMap((role) =>
      cloned.map((voice) => {
        const option = built.option(role, voice.key, cloned);
        built.rows[role].appendChild(option.cell);
        return option;
      }),
    );
    for (const voice of cloned) built.clones.appendChild(built.cloneRow(voice));
  };
  return {
    render: (shown) => {
      rebuild(shown.cloned);
      for (const option of [...built.hosted, ...cloneOptions]) {
        option.radio.checked = shown.picked[option.role] === option.voice;
        option.preview.dataset.sounding = String(shown.sounding === option.voice);
      }
      built.note.textContent = shown.audition.kind === "sample" ? shown.audition.note : "";
      built.note.hidden = shown.audition.kind !== "sample";
      built.reset.disabled = !shown.reset;
      const { phase, note } = shown.cloning;
      built.record.dataset.recording = String(phase.kind === "recording");
      built.record.textContent = phase.kind === "recording" ? STOP_LABEL : RECORD_LABEL;
      built.record.disabled = phase.kind === "making";
      built.upload.disabled = phase.kind !== "idle";
      built.name.disabled = phase.kind !== "idle";
      // The note is the last word said to the reader and outranks the phase's own line: a
      // word arrives only when there is something to say, and the phase is plain from the
      // buttons [LAW:no-silent-failure].
      const said = note ?? (phase.kind === "recording" ? `Recording ${phase.name || "your voice"}… read the passage. It stops itself after ${RECORDING_SECONDS} s, or tap Stop.` : phase.kind === "making" ? MAKING_NOTE : null);
      built.making.textContent = said ?? "";
      // [LAW:dataflow-not-control-flow] `aria-describedby` takes a LIST, and the two things worth
      // saying are independent, so they are computed independently and joined — never chosen
      // between. Picking one was the bug: describing the button by the note whenever a note
      // existed sounded right, until `Saved Brandon.` — which the reducer leaves standing through
      // the whole idle phase after a clone is kept — permanently replaced the words to read, so
      // a reader recording a second voice was told about the first one instead, for the rest of
      // the session. Describing it by the passage instead loses the reason a take just failed.
      // Both are true at once, and the reader wants both.
      //
      // What to read is withheld in exactly one state: the button is Stop mid-recording, where
      // reading the whole passage out would outlast the recording it was meant to help end.
      const saying = said === null ? null : built.making.id;
      const toRead = phase.kind === "recording" ? [] : [built.read.id, built.passage.id];
      // Upload is described by the same words as Record. Naming only Record here would leave the
      // Upload path with precisely the defect the passage exists to remove — a reader tabbing to
      // it in focus mode would be told nothing about what to read, nor that ten seconds of what
      // they send is what survives [LAW:single-enforcer].
      const describing = [saying, ...toRead].filter((id): id is string => id !== null).join(" ");
      built.record.setAttribute("aria-describedby", describing);
      built.upload.setAttribute("aria-describedby", describing);
    },
  };
};
