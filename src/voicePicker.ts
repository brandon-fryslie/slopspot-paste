// [LAW:decomposition] The voice picker's markup: a row per picked role listing the hosted
// voices by name, a button to hear each, the credit one hover away, and a reset. One
// sentence, no "and": this module draws the picker and reports the reader's taps. It
// decides nothing — which voices exist is the manifest's, what a tap means and whether it
// plays the voice itself or its sample is the panel's (listenPanel.ts) — and holds no state:
// every render writes every attribute from the readout it is handed, so no path leaves a
// stale check, a stale note or a stale sounding mark behind [LAW:dataflow-not-control-flow].
//
// BUILT, NOT TEMPLATED. The rows are the product of two lists — the picked roles and the
// hosted voices — and the credit beside each name is the manifest's, so the page carries
// an empty block and the rows are built here from the data the voice map is derived from
// [LAW:one-source-of-truth]: a seventh hosted voice is a seventh option with no template
// edit, and the check under jsdom meets the same rows the page does.
//
// THE CREDIT. The CC-BY voices require attribution; each name carries its voice's
// attribution and licence as its title, so the credit is one hover (or one long press)
// away without a line of chrome per voice.
//
// WHAT IT SOUNDS LIKE. The name is not a description, so each voice carries one beneath it
// (voiceChoice.voiceDescription) — shown, not hovered, because it is the thing a reader
// chooses by. It is the radio's `aria-describedby`, so the option announces as its name
// and then what it sounds like, rather than as one long name.

import { MODEL_ASSETS, VOICE_IDS, type VoiceId } from "./modelAssets";
import { PICKED_VOICES, ROLE_LABELS, voiceDescription, voiceName, type PickedVoice, type VoicePick } from "./voiceChoice";

// [LAW:types-are-the-program] How a voice is heard out: live, its phrase made by the model
// on this device, or from its sample (voiceSample.ts), with the note beside the rows that
// says so. A voice can always be heard; the note is what changes.
export type Audition = { readonly kind: "live" } | { readonly kind: "sample"; readonly note: string };

// What the picker shows: the pick, how a voice is heard out, the voice sounding now, and
// whether there is anything to reset. Declared here, filled by the panel's readout.
export interface VoicesReadout {
  readonly picked: VoicePick;
  readonly audition: Audition;
  readonly sounding: VoiceId | null;
  readonly reset: boolean;
}

export interface VoicePickerHandlers {
  readonly pick: (role: PickedVoice, voice: VoiceId) => void;
  readonly preview: (voice: VoiceId) => void;
  readonly reset: () => void;
}

export interface VoicePicker {
  readonly render: (shown: VoicesReadout) => void;
}

export const voiceCredit = (id: VoiceId): string => {
  const asset = MODEL_ASSETS.voices[id];
  return `${asset.attribution} · ${asset.licence}`;
};

interface Option {
  readonly role: PickedVoice;
  readonly voice: VoiceId;
  readonly cell: HTMLElement;
  readonly radio: HTMLInputElement;
  readonly preview: HTMLButtonElement;
}

const build = (root: HTMLElement, on: VoicePickerHandlers): { options: ReadonlyArray<Option>; note: HTMLElement; reset: HTMLButtonElement } => {
  const doc = root.ownerDocument;
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
  const option = (role: PickedVoice, voice: VoiceId): Option => {
    const radio = el("input", "voice-radio");
    radio.type = "radio";
    radio.id = `${root.id}-radio-${role}-${voice}`;
    radio.name = `voice-${role}`;
    radio.value = voice;
    radio.addEventListener("change", () => {
      if (radio.checked) on.pick(role, voice);
    });
    // The name is the radio's label rather than its wrapper, so the radio is a cell of the
    // option's grid and the description below it starts in the name's column without a
    // measured indent; tapping the name still picks the voice, which is what `for` means.
    const label = el("label", "voice-label");
    label.htmlFor = radio.id;
    label.title = voiceCredit(voice);
    label.textContent = voiceName(voice);
    const preview = el("button", "voice-preview");
    preview.type = "button";
    preview.setAttribute("aria-label", `Hear ${voiceName(voice)}`);
    preview.textContent = "▶";
    preview.addEventListener("click", () => on.preview(voice));
    const about = el("span", "voice-about");
    about.id = `${root.id}-about-${role}-${voice}`;
    about.textContent = voiceDescription(voice);
    radio.setAttribute("aria-describedby", about.id);
    const head = el("span", "voice-head");
    attach(head, label, preview);
    const cell = el("div", "voice-option");
    cell.dataset.voice = voice;
    attach(cell, radio, head, about);
    return { role, voice, cell, radio, preview };
  };
  const options = PICKED_VOICES.flatMap((role) => {
    const row = el("fieldset", "voice-row");
    row.dataset.role = role;
    const legend = el("legend", "voice-role");
    legend.textContent = ROLE_LABELS[role];
    const built = VOICE_IDS.map((voice) => option(role, voice));
    attach(row, legend, ...built.map((o) => o.cell));
    attach(root, row);
    return built;
  });
  const note = el("p", "voice-note");
  const reset = el("button", "mono-pill voice-reset");
  reset.type = "button";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", on.reset);
  attach(root, note, reset);
  return { options, note, reset };
};

export const mountVoicePicker = (root: HTMLElement, on: VoicePickerHandlers): VoicePicker => {
  // [LAW:no-silent-failure] Every option's id is scoped by the root's, because a document
  // resolves a `for` to the FIRST id that matches: two pickers sharing a namespace would
  // leave the second one's names quietly checking the first one's radios and calling the
  // first one's handler, moving nothing on screen. An id-less root has no namespace to
  // lend, so it is refused here rather than mounting a picker that works until it doesn't.
  if (root.id === "") throw new Error("mountVoicePicker: the picker's root needs an id — the options' ids are scoped by it");
  const { options, note, reset } = build(root, on);
  return {
    render: (shown) => {
      for (const option of options) {
        option.radio.checked = shown.picked[option.role] === option.voice;
        option.preview.dataset.sounding = String(shown.sounding === option.voice);
      }
      note.textContent = shown.audition.kind === "sample" ? shown.audition.note : "";
      note.hidden = shown.audition.kind !== "sample";
      reset.disabled = !shown.reset;
    },
  };
};
