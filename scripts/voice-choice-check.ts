// The reader's voice pick (slopspot-read-along-a35.7): the round trip through the device's
// storage, what a stored value this build did not write reads as, the default kept as
// absence, the rule that derives the four-role map from the two-role pick, and the phrase
// a preview says, and what each voice is described as. Run: `tsx scripts/voice-choice-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader would find on the
// next visit and what voice each role would be spoken in — never how the string is laid out.

import { MODEL_ASSETS, VOICE_IDS } from "../src/modelAssets";
import type { ClonedVoice } from "../src/clonedVoice";
import { CLONE_CREDIT, DEFAULT_PICK, DEFAULT_VOICES, PICK_KEY, previewText, readPick, samePick, voiceDescription, voiceMapOf, voiceName, writePick } from "../src/voiceChoice";
import type { VoicePick } from "../src/voiceChoice";
import { memoryPreferences, refusedPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, act: () => unknown): void => {
  let threw = false;
  try {
    act();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

const CHOSEN: VoicePick = { user: "paul", assistant: "jane", system: "vera" };

console.log("the pick's round trip");
{
  const store = memoryPreferences();
  assert("a device that never picked reads the default, with nothing stored", samePick(readPick(store, []), DEFAULT_PICK) && store.keys().length === 0);
  writePick(store, CHOSEN);
  assert("a pick written is the pick read, under the one key", samePick(readPick(store, []), CHOSEN) && store.keys().join() === PICK_KEY);
  writePick(store, { ...CHOSEN, user: "charles" });
  assert("a second write replaces the first", readPick(store, []).user === "charles" && readPick(store, []).assistant === "jane" && store.keys().length === 1);
  writePick(store, DEFAULT_PICK);
  assert("the default written is the key removed: a reset device and a fresh one are the same device", store.keys().length === 0 && samePick(readPick(store, []), DEFAULT_PICK));
  const trips = VOICE_IDS.flatMap((user) =>
    VOICE_IDS.map((assistant) => {
      const pick: VoicePick = { ...DEFAULT_PICK, user, assistant };
      writePick(store, pick);
      return samePick(readPick(store, []), pick);
    }),
  );
  assert(`every hosted voice survives the trip in either role (${trips.length} pairs)`, trips.every(Boolean));
}

console.log("a stored value this build did not write reads as the default, role by role");
{
  // A shape that names no role at all: every role reads as its default.
  const garbage = ["not json", '"charles"', "[]", "{}", '{"user":"charles"}', "null"];
  for (const raw of garbage) {
    const store = memoryPreferences();
    store.setItem(PICK_KEY, raw);
    assert(`${JSON.stringify(raw)} reads as the default`, samePick(readPick(store, []), DEFAULT_PICK));
  }

  // A role whose stored voice this device cannot speak with reads as THAT role's default,
  // alone — the reader's other choices are still the reader's. The same rule carries a
  // pick across a build that gave speech another row: the roles it knows survive, the new
  // one starts at its default, and nobody's preference is thrown away wholesale.
  const partial: ReadonlyArray<readonly [string, VoicePick]> = [
    ['{"user":7,"assistant":"charles"}', { ...DEFAULT_PICK, assistant: "charles" }],
    ['{"user":"charles","assistant":"nobody"}', { ...DEFAULT_PICK, user: "charles" }],
    ['{"user":"paul","assistant":"jane"}', { ...DEFAULT_PICK, user: "paul", assistant: "jane" }],
  ];
  for (const [raw, expected] of partial) {
    const store = memoryPreferences();
    store.setItem(PICK_KEY, raw);
    assert(`${JSON.stringify(raw)}: the roles it names survive, the rest read as their default`, samePick(readPick(store, []), expected));
  }
  const refusing = refusedPreferences();
  assert("a browser that refuses storage: the default, no throw", samePick(readPick(refusing, []), DEFAULT_PICK));
  let threw = false;
  try {
    writePick(refusing, CHOSEN);
  } catch {
    threw = true;
  }
  assert("a write the browser refuses does not throw: the pick is simply not kept", !threw);
}

console.log("the rule: a row per speaker, four voices");
{
  const map = voiceMapOf(CHOSEN);
  assert("the reader's row speaks for the user, Claude's for the assistant", map.user === "paul" && map.assistant === "jane");
  assert("the narrator takes Claude's voice", map.narrator === "jane");
  // The system is a SPEAKER, so it is a row the reader picks — a Claude Code transcript is
  // full of words the harness wrote and the reader never typed (parsers/jsonl.ts speakerOf).
  assert("the system's row speaks for the system, in the voice the reader gave it", map.system === "vera" && map.system !== map.user && map.system !== map.assistant);
  assert("the defaults: Charles for the reader, Javert for Claude and the narrator, Eponine for the system", DEFAULT_VOICES.user === "charles" && DEFAULT_VOICES.assistant === "javert" && DEFAULT_VOICES.narrator === "javert" && DEFAULT_VOICES.system === "eponine");
  assert("the same pick is the same pick; a pick that differs in one role is not", samePick(CHOSEN, { ...CHOSEN }) && !samePick(CHOSEN, { ...CHOSEN, user: "charles" }));
}

console.log("a clone is picked like any voice, and read back only while the device keeps it");
{
  const store = memoryPreferences();
  const mine: ClonedVoice = { key: `clone:${"a".repeat(64)}`, name: "Brandon", samples: new Int16Array(new ArrayBuffer(48000)) };
  writePick(store, { ...DEFAULT_PICK, user: mine.key, assistant: "jane" });
  assert("a pick naming a kept clone reads back as picked", readPick(store, [mine]).user === mine.key && readPick(store, [mine]).assistant === "jane");
  assert("the same pick on a device that no longer keeps the clone reads that role as its default, the other role kept", samePick(readPick(store, []), { ...DEFAULT_PICK, user: DEFAULT_PICK.user, assistant: "jane" }));
  store.setItem(PICK_KEY, JSON.stringify({ user: "clone:not-a-hash", assistant: "jane" }));
  assert("a clone key that is not a content hash is not a voice this device speaks with: that role reads as its default, the others kept", samePick(readPick(store, [mine]), { ...DEFAULT_PICK, assistant: "jane" }));
  assert("a clone is named by the reader, described as their recording, and credited as their own", voiceName(mine.key, [mine]) === "Brandon" && voiceDescription(mine.key, [mine]) === "Your recording · 1 s · kept on this device" && CLONE_CREDIT.startsWith("Recorded on this device"));
  assert("its preview phrase says the reader's name", previewText(mine.key, [mine]).source.includes("this is Brandon"));
  throws("a clone the device does not keep cannot be named: a pick that escaped the parse is a bug", () => voiceName(mine.key, []));
  assert("the map derived from a pick carries the clone for its role, and the narrator with Claude's", voiceMapOf({ ...DEFAULT_PICK, user: mine.key, assistant: mine.key }).narrator === mine.key && voiceMapOf({ ...DEFAULT_PICK, user: mine.key, assistant: "charles" }).user === mine.key);
}

console.log("the voices as the reader meets them");
{
  assert(
    "each voice is named for a person, its id being that name as a slug",
    voiceName("charles", []) === "Charles" &&
      voiceName("peter_yearsley", []) === "Peter Yearsley" &&
      VOICE_IDS.every((id) => voiceName(id, []) !== id && voiceName(id, []).replace(/ /g, "_").toLowerCase() === id),
  );
  const phrase = previewText("javert", []);
  assert("the preview says the voice's name, prepared as a script unit is", phrase.source.includes("this is Javert") && phrase.text.includes("this is Javert") && /[.!?]$/.test(phrase.text));
}

console.log("what each voice is like, in the words a reader picks by");
{
  // [LAW:behavior-not-structure] What a reader reads beside a name, not how it is stored.
  assert("a description is what it sounds like, where it sounds from, and which register", voiceDescription("eponine", []) === "Warm and even · North American · feminine");
  const described = VOICE_IDS.map((id) => voiceDescription(id, []));
  assert("every hosted voice is described: three parts, none of them empty", described.every((line) => line.split(" · ").length === 3 && line.split(" · ").every((part) => part.trim().length > 0)));
  assert("no two voices read alike: the description is what tells them apart", new Set(described).size === VOICE_IDS.length);
  assert("the register is one of the two words a row can be", VOICE_IDS.every((id) => ["masculine", "feminine"].includes(MODEL_ASSETS.voices[id].qualities.register)));
  // A name is not a voice: this catalogue once carried Alba, a woman's name over a man's
  // voice, and a reader going by the name alone would have picked wrong. The description is
  // the fix, so it must not merely repeat the name.
  assert("a description never leans on the name", VOICE_IDS.every((id) => !voiceDescription(id, []).toLowerCase().includes(id)));
}

console.log(process.exitCode === 1 ? "voice-choice-check: FAILED" : "voice-choice-check: ok");
