// The voice sample (slopspot-voices-9p4.tqc): every hosted voice's sample is on disk as the
// bytes the manifest pins, at the path the page asks for, and the player sounds one voice at
// a time over the page's audio element. Run: `tsx scripts/voice-sample-check.ts`.
//
// [LAW:behavior-not-structure] The file assertions are what a build publishes and a browser
// fetches; the player assertions are what the element was told and what the picker is told.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isClonedKey, type VoiceKey } from "../src/clonedVoice";
import { MODEL_ASSETS, SHA_PREFIX_CHARS, VOICE_IDS, type VoiceId } from "../src/modelAssets";
import { createSamplePlayer, SAMPLE_PREFIX, sampleFile, samplePath } from "../src/voiceSample";
import { StubAudio } from "./playbackStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", SAMPLE_PREFIX);

console.log("the samples on disk are the bytes the manifest pins");
{
  assert("a sample's path is its voice and a prefix of its hash under the samples' prefix", samplePath("charles") === `/voices/charles-${MODEL_ASSETS.voices.charles.sample.sha256.slice(0, SHA_PREFIX_CHARS)}.m4a`);
  for (const id of VOICE_IDS) {
    const { sample } = MODEL_ASSETS.voices[id];
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(join(samplesDir, sampleFile(id, sample.sha256)));
    } catch {
      bytes = null;
    }
    const hash = bytes === null ? "" : createHash("sha256").update(bytes).digest("hex");
    assert(`${id}: the file at its pinned path is its pinned bytes, an MP4 audio file`, bytes !== null && bytes.byteLength === sample.bytes && hash === sample.sha256 && bytes.subarray(4, 8).toString("latin1") === "ftyp");
  }
  // Each pinned file's presence is settled above [LAW:single-enforcer]; what is left to say
  // is that nothing else is there, and to name what is when something is.
  const expected = VOICE_IDS.map((id) => sampleFile(id, MODEL_ASSETS.voices[id].sample.sha256));
  const stray = readdirSync(samplesDir).filter((file) => !expected.includes(file));
  assert(`nothing under the samples' prefix but the pinned samples: a stale render never ships${stray.length === 0 ? "" : ` — found ${stray.join(", ")}`}`, stray.length === 0);
}

// The page's rule for where a sample is: a hosted voice's path; a clone's is its recording.
const hostedSrc = (voice: VoiceKey): string => (isClonedKey(voice) ? `blob:${voice}` : samplePath(voice));

console.log("the player: one voice at a time, told to the picker on every change");
{
  const changes: (VoiceKey | null)[] = [];
  const player = createSamplePlayer({ Audio: () => new StubAudio(), src: hostedSrc, onChange: (voice) => changes.push(voice) });
  const audio = StubAudio.instances.at(-1);
  if (audio === undefined) throw new Error("fixture: no audio element");
  assert("built: one element, nothing sounding, nothing said", StubAudio.instances.length === 1 && changes.length === 0);
  player.say("charles");
  assert("a voice said: its sample's path played from the element, and the voice told", audio.plays.join() === samplePath("charles") && changes.join() === "charles");
  player.say("paul");
  assert("another said over it: the first paused, the second played, the change told", audio.paused === 2 && audio.plays.join() === `${samplePath("charles")},${samplePath("paul")}` && changes.join() === "charles,paul");
  audio.end();
  assert("the sample ends: nothing sounding, told once", changes.map(String).join() === "charles,paul,null");
  audio.end();
  assert("an end with nothing sounding says nothing", changes.length === 3);
  player.say("javert");
  player.hush();
  assert("hushed: paused, nothing sounding", audio.paused === 4 && changes.map(String).join() === "charles,paul,null,javert,null");
  player.dispose();
  assert("dispose is a hush", changes.length === 5);
}
{
  const changes: (VoiceKey | null)[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(String(args[0]));
  const player = createSamplePlayer({ Audio: () => new StubAudio("NotAllowedError"), src: hostedSrc, onChange: (voice) => changes.push(voice) });
  player.say("charles");
  await new Promise((resolve) => setImmediate(resolve));
  console.warn = warn;
  assert("a play the browser refuses: said on the console, and the voice unlit", warned.length === 1 && warned[0]?.includes("charles") === true && changes.map(String).join() === "charles,null");
}
{
  const changes: (VoiceKey | null)[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(String(args[0]));
  const player = createSamplePlayer({ Audio: () => new StubAudio(), src: hostedSrc, onChange: (voice) => changes.push(voice) });
  const audio = StubAudio.instances.at(-1);
  if (audio === undefined) throw new Error("fixture: no audio element");
  player.say("charles");
  player.say("paul");
  audio.abort(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert("the first play, superseded before it began, is rejected: the second stays lit, nothing said", warned.length === 0 && changes.map(String).join() === "charles,paul");
  player.hush();
  audio.abort(1);
  await new Promise((resolve) => setImmediate(resolve));
  player.say("javert");
  player.say("javert");
  audio.abort(2);
  await new Promise((resolve) => setImmediate(resolve));
  console.warn = warn;
  assert("a hushed play rejected after the hush: nothing said, nothing to unlight", warned.length === 0 && changes.map(String).join() === "charles,paul,null,javert");
  assert("the same voice heard twice: the second play stands, the first's rejection unlights nothing", warned.length === 0 && changes.map(String).join() === "charles,paul,null,javert");
}
{
  const changes: (VoiceKey | null)[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.join(" "));
  const player = createSamplePlayer({ Audio: () => new StubAudio(), src: hostedSrc, onChange: (voice) => changes.push(voice) });
  const audio = StubAudio.instances.at(-1);
  if (audio === undefined) throw new Error("fixture: no audio element");
  player.say("charles");
  audio.fail("the connection dropped");
  assert("the element fails mid-sample: said with the browser's reason, and the voice unlit", warned.length === 1 && warned[0]?.includes("charles") === true && warned[0]?.includes("the connection dropped") === true && changes.map(String).join() === "charles,null");
  player.say("paul");
  audio.fail("");
  console.warn = warn;
  assert("a browser that gives no reason — most but Chrome — still says which voice stopped, and why it cannot say more", warned.length === 2 && warned[1]?.includes("paul") === true && warned[1]?.endsWith("the element gave no reason") === true);
}

console.log(process.exitCode === 1 ? "voice-sample-check: FAILED" : "voice-sample-check: ok");
