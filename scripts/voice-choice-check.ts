// The reader's voice pick (slopspot-read-along-a35.7): the round trip through the device's
// storage, what a stored value this build did not write reads as, the default kept as
// absence, the rule that derives the four-role map from the two-role pick, and the phrase
// a preview says. Run: `tsx scripts/voice-choice-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader would find on the
// next visit and what voice each role would be spoken in — never how the string is laid out.

import { VOICE_IDS } from "../src/modelAssets";
import type { PreferenceStore } from "../src/preferenceStore";
import { DEFAULT_PICK, DEFAULT_VOICES, PICK_KEY, SYSTEM_VOICE, previewText, readPick, samePick, voiceMapOf, voiceName, writePick } from "../src/voiceChoice";
import type { VoicePick } from "../src/voiceChoice";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const CHOSEN: VoicePick = { user: "marius", assistant: "fantine" };

console.log("the pick's round trip");
{
  const store = memoryPreferences();
  assert("a device that never picked reads the default, with nothing stored", samePick(readPick(store), DEFAULT_PICK) && store.keys().length === 0);
  writePick(store, CHOSEN);
  assert("a pick written is the pick read, under the one key", samePick(readPick(store), CHOSEN) && store.keys().join() === PICK_KEY);
  writePick(store, { ...CHOSEN, user: "alba" });
  assert("a second write replaces the first", readPick(store).user === "alba" && readPick(store).assistant === "fantine" && store.keys().length === 1);
  writePick(store, DEFAULT_PICK);
  assert("the default written is the key removed: a reset device and a fresh one are the same device", store.keys().length === 0 && samePick(readPick(store), DEFAULT_PICK));
  const trips = VOICE_IDS.flatMap((user) =>
    VOICE_IDS.map((assistant) => {
      const pick: VoicePick = { user, assistant };
      writePick(store, pick);
      return samePick(readPick(store), pick);
    }),
  );
  assert(`every hosted voice survives the trip in either role (${trips.length} pairs)`, trips.every(Boolean));
}

console.log("a stored value this build did not write reads as the default");
{
  const garbage = ["not json", '"alba"', "[]", "{}", '{"user":"alba"}', '{"user":"alba","assistant":"nobody"}', '{"user":7,"assistant":"alba"}', "null"];
  for (const raw of garbage) {
    const store = memoryPreferences();
    store.setItem(PICK_KEY, raw);
    assert(`${JSON.stringify(raw)} reads as the default`, samePick(readPick(store), DEFAULT_PICK));
  }
  const refuse = (): never => {
    throw new Error("storage refused");
  };
  const refusing: PreferenceStore = { getItem: refuse, setItem: refuse, removeItem: refuse };
  assert("a browser that refuses storage: the default, no throw", samePick(readPick(refusing), DEFAULT_PICK));
  let threw = false;
  try {
    writePick(refusing, CHOSEN);
  } catch {
    threw = true;
  }
  assert("a write the browser refuses does not throw: the pick is simply not kept", !threw);
}

console.log("the rule: two rows, four voices");
{
  const map = voiceMapOf(CHOSEN);
  assert("the reader's row speaks for the user, Claude's for the assistant", map.user === "marius" && map.assistant === "fantine");
  assert("the narrator takes Claude's voice", map.narrator === "fantine");
  assert("the system message keeps a voice of its own, not the reader's and not Claude's", map.system === SYSTEM_VOICE && map.system !== map.user && map.system !== map.assistant);
  assert("the defaults: Alba for the reader, Javert for Claude and the narrator, Eponine for the system", DEFAULT_VOICES.user === "alba" && DEFAULT_VOICES.assistant === "javert" && DEFAULT_VOICES.narrator === "javert" && DEFAULT_VOICES.system === "eponine");
  assert("the same pick is the same pick; a pick that differs in one role is not", samePick(CHOSEN, { ...CHOSEN }) && !samePick(CHOSEN, { ...CHOSEN, user: "alba" }));
}

console.log("the voices as the reader meets them");
{
  assert("each voice is named for a person", voiceName("alba") === "Alba" && VOICE_IDS.every((id) => voiceName(id) !== id && voiceName(id).toLowerCase() === id));
  const phrase = previewText("javert");
  assert("the preview says the voice's name, prepared as a script unit is", phrase.source.includes("this is Javert") && phrase.text.includes("this is Javert") && /[.!?]$/.test(phrase.text));
}

console.log(process.exitCode === 1 ? "voice-choice-check: FAILED" : "voice-choice-check: ok");
