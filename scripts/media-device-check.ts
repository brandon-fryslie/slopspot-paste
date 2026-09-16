// The audio device with a media element beside it (slopspot-read-along-a35.5). Run:
// `tsx scripts/media-device-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what the platform and the reader get: the
// voice sounds from the context on the speakers, the clock is the context's, the element plays
// exactly while the context runs for a listen — never for an unlock, which only primes it, and
// only once — a pause the device did not ask for is said, a refused play is said while the
// voice sounds on, and the carrier is a silent file long enough to count as media. The stubs
// implement only the seam mediaDevice.ts declares.

import { CARRIER_SECONDS, carrierWav, mediaDevice, type MediaElement, type SoundContext } from "../src/mediaDevice";
import type { PcmBuffer, PcmSource } from "../src/unitPlayer";
import { StubBuffer, StubSource } from "./playbackStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── stubs ─────────────────────────────────────────────────────────────────────────────

const SPEAKERS = { node: "speakers" };

class StubContext implements SoundContext {
  static last: StubContext | null = null;
  currentTime = 12.5;
  readonly destination = SPEAKERS;
  readonly calls: string[] = [];
  constructor(readonly options: { readonly sampleRate: number }) {
    StubContext.last = this;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): PcmBuffer {
    return new StubBuffer(length, sampleRate);
  }
  createBufferSource(): PcmSource {
    return new StubSource();
  }
  resume(): Promise<void> {
    this.calls.push("resume");
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.calls.push("suspend");
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.calls.push("close");
    return Promise.resolve();
  }
}

// An element whose plays are answered as the check says; a pause fires its event a task
// later, as a browser's does, and a pause before a play has settled rejects that play as
// aborted, as a browser's does.
class StubElement implements MediaElement {
  paused = true;
  answer: "plays" | "refuses" = "plays";
  readonly calls: string[] = [];
  readonly #listeners: Array<() => void> = [];
  #pending: ((error: Error) => void) | null = null;
  play(): Promise<void> {
    this.calls.push("play");
    if (this.answer === "refuses") return Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }));
    this.paused = false;
    return new Promise((resolve, reject) => {
      this.#pending = reject;
      setTimeout(() => {
        if (this.#pending === reject) resolve();
        this.#pending = null;
      }, 1);
    });
  }
  pause(): void {
    this.calls.push("pause");
    if (this.paused) return;
    this.paused = true;
    this.#pending?.(Object.assign(new Error("AbortError"), { name: "AbortError" }));
    this.#pending = null;
    setTimeout(() => this.#fire(), 0);
  }
  // The platform pausing the element on its own.
  platformPause(): void {
    this.paused = true;
    setTimeout(() => this.#fire(), 0);
  }
  addEventListener(_type: "pause", listener: () => void): void {
    this.#listeners.push(listener);
  }
  #fire(): void {
    for (const listener of this.#listeners) listener();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const rig = () => {
  const elements: StubElement[] = [];
  const said = { interrupted: 0, refused: [] as unknown[] };
  const Device = mediaDevice({
    Context: StubContext,
    element: () => {
      const element = new StubElement();
      elements.push(element);
      return element;
    },
    interrupted: () => {
      said.interrupted += 1;
    },
    refused: (error) => {
      said.refused.push(error);
    },
  });
  const device = new Device({ sampleRate: 24_000 });
  const context = StubContext.last;
  const element = elements[0];
  if (context === null || element === undefined) throw new Error("fixture: the device built no context or element");
  return { device, context, element, said };
};

// The real AudioContext and <audio> must fit the seams the device declares; these lines are
// the proof the page's wiring rests on, checked here where the DOM lib is present.
type RealContextFits = typeof AudioContext extends new (options: { readonly sampleRate: number }) => SoundContext ? true : never;
type RealElementFits = HTMLAudioElement extends MediaElement ? true : never;
const realContextFits: RealContextFits = true;
const realElementFits: RealElementFits = true;
assert("typeof AudioContext satisfies the device's context, and HTMLAudioElement its element", realContextFits && realElementFits);

const plays = (element: StubElement): number => element.calls.filter((c) => c === "play").length;

// ── the checks ────────────────────────────────────────────────────────────────────────

console.log("mediaDevice: the voice sounds from the context; the element plays while it does");
{
  const { device, context, element, said } = rig();
  assert("the context is opened at the rate asked, and sources connect straight to its speakers", context.options.sampleRate === 24_000 && device.destination === SPEAKERS);
  assert("the clock is the context's", device.currentTime === 12.5);
  device.resume();
  assert("resume plays the element and resumes the context, both on the caller's stack", element.calls.join() === "play" && context.calls.join() === "resume" && !element.paused);
  void device.suspend();
  assert("suspend pauses the element with the context", element.calls.join() === "play,pause" && context.calls.join() === "resume,suspend" && element.paused);
  await tick();
  assert("the element's play, cut short by that pause, is not a refusal; the device's own pause is not an interruption", said.refused.length === 0 && said.interrupted === 0);
}

console.log("mediaDevice: an unlock sounds nothing — it primes the element once and resumes the context");
{
  const { device, context, element, said } = rig();
  void device.unlock();
  assert("the element is played and paused on the caller's stack, the context resumed", element.calls.join() === "play,pause" && element.paused && context.calls.join() === "resume");
  await tick();
  assert("the prime is neither a refusal nor an interruption", said.refused.length === 0 && said.interrupted === 0);
  void device.unlock();
  assert("a second unlock resumes the context and leaves the element alone", element.calls.join() === "play,pause" && context.calls.join() === "resume,resume");
  device.resume();
  assert("a later resume plays the element for the listen", plays(element) === 2 && !element.paused);
}

console.log("mediaDevice: a pause the device did not ask for is said; its own are not");
{
  const { device, element, said } = rig();
  device.resume();
  void device.suspend();
  await tick();
  void device.suspend();
  await tick();
  assert("a suspend over a paused element pauses nothing more, and says nothing", said.interrupted === 0 && element.calls.filter((c) => c === "pause").length === 1);
  device.resume();
  await tick();
  element.platformPause();
  await tick();
  assert("the platform pausing the element: said once to the owner", said.interrupted === 1);
  void device.close();
  await tick();
  assert("close over the platform's pause: nothing more said", said.interrupted === 1);
}

console.log("mediaDevice: a refused play is said, and the voice sounds on");
{
  const { device, context, element, said } = rig();
  element.answer = "refuses";
  device.resume();
  await tick();
  assert("refused: said, the context resumed all the same, the sources still bound for the speakers", said.refused.length === 1 && context.calls.join() === "resume" && device.destination === SPEAKERS);
  element.answer = "plays";
  device.resume();
  await tick();
  assert("the next play asks again, and is heard", plays(element) === 2 && !element.paused && said.refused.length === 1);
}

console.log("carrierWav: a silent PCM file longer than the five seconds under which Chrome counts a sound as transient");
{
  const wav = carrierWav();
  const view = new DataView(wav);
  const text = (at: number, length: number): string => String.fromCharCode(...new Uint8Array(wav, at, length));
  const rate = view.getUint32(24, true);
  const bytesPerSecond = view.getUint32(28, true);
  const dataBytes = view.getUint32(40, true);
  assert("a RIFF WAVE of PCM, mono, 8-bit", text(0, 4) === "RIFF" && view.getUint32(4, true) === wav.byteLength - 8 && text(8, 4) === "WAVE" && text(12, 4) === "fmt " && view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 8 && text(36, 4) === "data" && dataBytes === wav.byteLength - 44);
  assert("its length is CARRIER_SECONDS, more than five", dataBytes / bytesPerSecond === CARRIER_SECONDS && CARRIER_SECONDS > 5 && rate === bytesPerSecond);
  assert("every sample is silence", new Uint8Array(wav, 44).every((sample) => sample === 128));
}

console.log(process.exitCode === 1 ? "media-device-check: FAILED" : "media-device-check: ok");
