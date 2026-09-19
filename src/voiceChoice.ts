// [LAW:decomposition] The reader's voice choice: which hosted voice speaks for them and
// which for Claude, kept on this device. One sentence, no "and" — this module turns the
// pick into the voice map the script is derived with, and keeps the pick in the device's
// storage. It plays nothing and knows no panel state: the panel (listenPanel.ts) reads the
// pick at every render, writes it from the picker, and hands the map to the performer.
//
// A CLONE IS A VOICE LIKE ANY OTHER. A voice the reader recorded (clonedVoice.ts) is picked
// by its key exactly as a hosted voice is by its id; the pick names it, and reads it back
// only while the device still keeps the clone — a pick naming a clone since removed reads as
// the default for that role, so the map never names a voice nobody can speak with.
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
// scripts/voice-choice-check.ts drives them over a Map; the page hands them the device's
// storage through preferenceStore.deviceStore, which answers a refused store.

import { CLONE_SECONDS, isClonedKey, type ClonedVoice, type ClonedVoiceKey, type VoiceKey } from "./clonedVoice";
import { MODEL_ASSETS, SAMPLE_RATE, VOICE_IDS, type VoiceId } from "./modelAssets";
import type { PreferenceStore } from "./preferenceStore";
import { prepareText, type UnitText, type VoiceMap } from "./speechScript";

// [LAW:types-are-the-program] The roles the reader picks a voice for: the picker's rows.
export const PICKED_VOICES = ["user", "assistant"] as const;
export type PickedVoice = (typeof PICKED_VOICES)[number];
export type VoicePick = Readonly<Record<PickedVoice, VoiceKey>>;

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
// edit, a string that is not JSON at all — is not a preference, and reads as none. A role
// naming a clone the device no longer keeps reads as that role's default, alone: the other
// role's pick is still the reader's.
const parsePick = (raw: string | null, clones: ReadonlyArray<ClonedVoice>): VoicePick => {
  if (raw === null) return DEFAULT_PICK;
  const parsed = jsonOf(raw);
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PICK;
  const { user, assistant } = parsed as Record<string, unknown>;
  const isKey = (value: unknown): value is VoiceKey => isVoiceId(value) || (typeof value === "string" && isClonedKey(value));
  if (!isKey(user) || !isKey(assistant)) return DEFAULT_PICK;
  const kept = (voice: VoiceKey, role: PickedVoice): VoiceKey => (isClonedKey(voice) && !clones.some((clone) => clone.key === voice) ? DEFAULT_PICK[role] : voice);
  return { user: kept(user, "user"), assistant: kept(assistant, "assistant") };
};

// A stored string's JSON, or null when it is not JSON.
// [LAW:no-silent-failure] exception: a string that is not JSON is not a pick this build
// wrote, so it reads as none, like any other shape the parse does not know.
const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// The device's pick: a store that holds none, or refuses (deviceStore reads a refused store
// as nothing), reads as the default. `clones` is what the device keeps (clonedVoice.ts
// readClones), the voices a pick may name besides the hosted ones.
export const readPick = (store: PreferenceStore, clones: ReadonlyArray<ClonedVoice>): VoicePick => parsePick(store.getItem(PICK_KEY), clones);

export const writePick = (store: PreferenceStore, pick: VoicePick): void => {
  if (samePick(pick, DEFAULT_PICK)) store.removeItem(PICK_KEY);
  else store.setItem(PICK_KEY, JSON.stringify(pick));
};

// ── the voices, as the reader meets them ────────────────────────────────────────────

// [LAW:parse-dont-validate] The clone a key names, among what the device keeps; a key that
// names none is a pick that escaped `parsePick`, a bug, thrown.
export const cloneOf = (voice: ClonedVoiceKey, clones: ReadonlyArray<ClonedVoice>): ClonedVoice => {
  const clone = clones.find((held) => held.key === voice);
  if (clone === undefined) throw new Error(`voice ${voice} is not a clone this device keeps`);
  return clone;
};

// Each hosted voice is named for a person, the id being the name in lower case; a clone is
// named by the reader who made it.
export const voiceName = (voice: VoiceKey, clones: ReadonlyArray<ClonedVoice>): string =>
  isClonedKey(voice) ? cloneOf(voice, clones).name : voice.charAt(0).toUpperCase() + voice.slice(1);

// What a voice is like, in one line beside its name — because the name says nothing, and
// Kyutai's Les Misérables names say something false: Alba is a man's voice. The three
// qualities are the manifest's [LAW:one-source-of-truth]; this is only how they read.
export const voiceDescription = (voice: VoiceKey, clones: ReadonlyArray<ClonedVoice>): string => {
  if (isClonedKey(voice)) return `Your recording · ${Math.round(cloneOf(voice, clones).samples.length / SAMPLE_RATE)} s · kept on this device`;
  const { character, accent, register } = MODEL_ASSETS.voices[voice].qualities;
  return `${character} · ${accent} · ${register}`;
};

// What a clone is credited as, where a hosted voice's row carries its licence: the reader's own.
export const CLONE_CREDIT = `Recorded on this device · at most ${CLONE_SECONDS} s`;

// The phrase a preview says, prepared exactly as a script unit is (speechScript.ts), so
// the model is fed the shape it is fed for the page. Thirteen words: well under the unit
// budget, and long enough to hear a voice's character.
export const previewText = (voice: VoiceKey, clones: ReadonlyArray<ClonedVoice>): UnitText => {
  const source = `Hello, this is ${voiceName(voice, clones)}. I can read this conversation to you.`;
  return { ...prepareText(source), source };
};
