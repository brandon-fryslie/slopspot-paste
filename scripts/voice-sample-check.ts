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
import { MODEL_ASSETS, VOICE_IDS, type VoiceId } from "../src/modelAssets";
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
  assert("a sample's path is its voice and a prefix of its hash under the samples' prefix", samplePath("alba") === `/voices/alba-${MODEL_ASSETS.voices.alba.sample.sha256.slice(0, 12)}.m4a`);
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
  const expected = VOICE_IDS.map((id) => sampleFile(id, MODEL_ASSETS.voices[id].sample.sha256)).sort();
  assert("nothing under the samples' prefix but the pinned samples: a stale render never ships", JSON.stringify(readdirSync(samplesDir).sort()) === JSON.stringify(expected));
}

console.log("the player: one voice at a time, told to the picker on every change");
{
  const changes: (VoiceId | null)[] = [];
  const player = createSamplePlayer({ Audio: () => new StubAudio(), onChange: (voice) => changes.push(voice) });
  const audio = StubAudio.instances.at(-1);
  if (audio === undefined) throw new Error("fixture: no audio element");
  assert("built: one element, nothing sounding, nothing said", StubAudio.instances.length === 1 && changes.length === 0);
  player.say("alba");
  assert("a voice said: its sample's path played from the element, and the voice told", audio.plays.join() === samplePath("alba") && changes.join() === "alba");
  player.say("marius");
  assert("another said over it: the first paused, the second played, the change told", audio.paused === 2 && audio.plays.join() === `${samplePath("alba")},${samplePath("marius")}` && changes.join() === "alba,marius");
  audio.end();
  assert("the sample ends: nothing sounding, told once", changes.map(String).join() === "alba,marius,null");
  audio.end();
  assert("an end with nothing sounding says nothing", changes.length === 3);
  player.say("javert");
  player.hush();
  assert("hushed: paused, nothing sounding", audio.paused === 4 && changes.map(String).join() === "alba,marius,null,javert,null");
  player.dispose();
  assert("dispose is a hush", changes.length === 5);
}
{
  const changes: (VoiceId | null)[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(String(args[0]));
  const player = createSamplePlayer({ Audio: () => new StubAudio("NotAllowedError"), onChange: (voice) => changes.push(voice) });
  player.say("alba");
  await new Promise((resolve) => setImmediate(resolve));
  console.warn = warn;
  assert("a play the browser refuses: said on the console, and the voice unlit", warned.length === 1 && warned[0]?.includes("alba") === true && changes.map(String).join() === "alba,null");
}

console.log(process.exitCode === 1 ? "voice-sample-check: FAILED" : "voice-sample-check: ok");
