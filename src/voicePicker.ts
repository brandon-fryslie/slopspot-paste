// [LAW:decomposition] The voice picker's markup: a row per picked role listing the hosted
// voices by name, a preview beside each name, the credit one hover away, and a reset. One
// sentence, no "and": this module draws the picker and reports the reader's taps. It
// decides nothing — which voices exist is the manifest's, what a tap means is the panel's
// (listenPanel.ts) — and holds no state: every render writes every attribute from the
// readout it is handed, so no path leaves a stale check, a stale note or a stale sounding
// mark behind [LAW:dataflow-not-control-flow].
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

import { MODEL_ASSETS, VOICE_IDS, type VoiceId } from "./modelAssets";
import { PICKED_VOICES, ROLE_LABELS, voiceName, type PickedVoice, type VoicePick } from "./voiceChoice";

// [LAW:types-are-the-program] Whether a voice can be heard out: offered once the model is
// warm, withheld — with the reason, shown beside the rows — before that.
export type PreviewOffer = { readonly kind: "offered" } | { readonly kind: "withheld"; readonly why: string };

// What the picker shows: the pick, whether previews are offered, the voice sounding now,
// and whether there is anything to reset. Declared here, filled by the panel's readout.
export interface VoicesReadout {
  readonly picked: VoicePick;
  readonly preview: PreviewOffer;
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
  const option = (role: PickedVoice, voice: VoiceId): Option => {
    const label = el("label", "voice-label");
    label.title = voiceCredit(voice);
    const radio = el("input", "voice-radio");
    radio.type = "radio";
    radio.name = `voice-${role}`;
    radio.value = voice;
    radio.addEventListener("change", () => {
      if (radio.checked) on.pick(role, voice);
    });
    const name = el("span", "voice-name");
    name.textContent = voiceName(voice);
    label.append(radio, name);
    const preview = el("button", "voice-preview");
    preview.type = "button";
    preview.setAttribute("aria-label", `Hear ${voiceName(voice)}`);
    preview.textContent = "▶";
    preview.addEventListener("click", () => on.preview(voice));
    const cell = el("div", "voice-option");
    cell.dataset.voice = voice;
    cell.append(label, preview);
    return { role, voice, cell, radio, preview };
  };
  const options = PICKED_VOICES.flatMap((role) => {
    const row = el("fieldset", "voice-row");
    row.dataset.role = role;
    const legend = el("legend", "voice-role");
    legend.textContent = ROLE_LABELS[role];
    const built = VOICE_IDS.map((voice) => option(role, voice));
    row.append(legend, ...built.map((o) => o.cell));
    root.append(row);
    return built;
  });
  const note = el("p", "voice-note");
  const reset = el("button", "mono-pill voice-reset");
  reset.type = "button";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", on.reset);
  root.append(note, reset);
  return { options, note, reset };
};

export const mountVoicePicker = (root: HTMLElement, on: VoicePickerHandlers): VoicePicker => {
  const { options, note, reset } = build(root, on);
  return {
    render: (shown) => {
      const withheld = shown.preview.kind === "withheld";
      for (const option of options) {
        option.radio.checked = shown.picked[option.role] === option.voice;
        option.preview.disabled = withheld;
        option.preview.dataset.sounding = String(shown.sounding === option.voice);
      }
      note.textContent = shown.preview.kind === "withheld" ? shown.preview.why : "";
      note.hidden = !withheld;
      reset.disabled = !shown.reset;
    },
  };
};
