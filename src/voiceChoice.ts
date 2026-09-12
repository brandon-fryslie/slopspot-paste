// [LAW:decomposition] The reader's voice choice: which hosted voice speaks for them and
// which for Claude, kept on this device. One sentence, no "and" — this module turns the
// pick into the voice map the script is derived with, and keeps the pick in the device's
// storage. It plays nothing and knows no panel state: the panel (listenPanel.ts) reads the
// pick at every render, writes it from the picker, and hands the map to the performer.
//
// TWO ROWS, NOT FOUR. The speech has four voices (speech.ts: user, assistant, system,
// narrator) and the picker offers two: the reader's own and Claude's. The other two follow
// a rule rather than a row — the narrator, our own words announcing a code block or a
// folded turn, speaks with the assistant's voice, and the system message keeps a voice of
// its own — so the picker cannot grow a row per role the speech invents. The rule is
// `voiceMapOf`, the one derivation of the map from the pick [LAW:one-source-of-truth].
//
// A VALUE, NOT AN ASSET. All six voices are loaded beside the weights, so a pick downloads
// nothing and changes no asset: the map is data the performer reads, and the rendition
// hash already names the voice each unit is spoken in. Cost, stated once: a preview is one
// short generation on the GPU.
//
// [LAW:effects-at-boundaries] Storage is a parameter of the two edges below, so
// scripts/voice-choice-check.ts drives them over a Map; the page hands window.localStorage.

import { VOICE_IDS, type VoiceId } from "./modelAssets";
import type { PreferenceStore } from "./preferenceStore";
import { prepareText, type UnitText, type VoiceMap } from "./speechScript";

// [LAW:types-are-the-program] The roles the reader picks a voice for: the picker's rows.
export const PICKED_VOICES = ["user", "assistant"] as const;
export type PickedVoice = (typeof PICKED_VOICES)[number];
export type VoicePick = Readonly<Record<PickedVoice, VoiceId>>;

// What the rows are called: the reader, and the assistant by the name the site gives it.
export const ROLE_LABELS: Readonly<Record<PickedVoice, string>> = { user: "You", assistant: "Claude" };

// Until the reader picks, the q35.1 spike's word-accuracy ranking chooses: the voices
// Whisper transcribed with zero errors take the roles that say the most.
export const DEFAULT_PICK: VoicePick = { user: "alba", assistant: "javert" };

// The system message's own voice: not picked, not the reader's, not Claude's.
export const SYSTEM_VOICE: VoiceId = "eponine";

// The rule: the map the script is derived with, from the pick.
export const voiceMapOf = (pick: VoicePick): VoiceMap => ({
  user: pick.user,
  assistant: pick.assistant,
  system: SYSTEM_VOICE,
  narrator: pick.assistant,
});

export const DEFAULT_VOICES: VoiceMap = voiceMapOf(DEFAULT_PICK);

export const samePick = (a: VoicePick, b: VoicePick): boolean => PICKED_VOICES.every((role) => a[role] === b[role]);

// ── the device's storage ────────────────────────────────────────────────────────────

// One key, one value: the pick as JSON, or absent. The default pick is written as absence,
// so a device that never picked and one reset to the defaults read the same
// [LAW:one-type-per-behavior].
export const PICK_KEY = "listen.voices";

const isVoiceId = (value: unknown): value is VoiceId => typeof value === "string" && (VOICE_IDS as ReadonlyArray<string>).includes(value);

// [LAW:parse-dont-validate] The stored string becomes a pick or the default: a value that
// is not a pick this build wrote — another build's shape, a voice no longer hosted, a hand
// edit — is not a preference, and reads as none.
const parsePick = (raw: string | null): VoicePick => {
  if (raw === null) return DEFAULT_PICK;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PICK;
  const { user, assistant } = parsed as Record<string, unknown>;
  return isVoiceId(user) && isVoiceId(assistant) ? { user, assistant } : DEFAULT_PICK;
};

// [LAW:no-silent-failure] exception: a browser that refuses site storage throws on the
// store itself, and a stored string that is not JSON throws in the parse; both read as
// the default — the pick is a convenience, and a refused store must not take Listen down
// with it (listenConsent.ts makes the same trade).
export const readPick = (store: PreferenceStore): VoicePick => {
  try {
    return parsePick(store.getItem(PICK_KEY));
  } catch {
    return DEFAULT_PICK;
  }
};

export const writePick = (store: PreferenceStore, pick: VoicePick): void => {
  try {
    if (samePick(pick, DEFAULT_PICK)) store.removeItem(PICK_KEY);
    else store.setItem(PICK_KEY, JSON.stringify(pick));
  } catch {
    /* storage refused — the pick is not kept; the listen under way is unaffected */
  }
};

// ── the voices, as the reader meets them ────────────────────────────────────────────

// Each voice is named for a person; the id is the name in lower case.
export const voiceName = (id: VoiceId): string => id.charAt(0).toUpperCase() + id.slice(1);

// The phrase a preview says, prepared exactly as a script unit is (speechScript.ts), so
// the model is fed the shape it is fed for the page. Thirteen words: well under the unit
// budget, and long enough to hear a voice's character.
export const previewText = (id: VoiceId): UnitText => {
  const source = `Hello, this is ${voiceName(id)}. I can read this conversation to you.`;
  return { text: prepareText(source), source };
};
