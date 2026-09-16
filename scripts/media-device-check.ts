// The audio device played through a media element (slopspot-read-along-a35.5). Run:
// `tsx scripts/media-device-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what the platform and the reader get: the
// context's sound reaches the element's stream, the element plays exactly while the context
// runs and is started on the caller's own stack, the clock is the context's, a pause the
// device did not ask for is said, and a refused play puts the voice on the speakers rather
// than leaving it silent. The stubs implement only the seam mediaDevice.ts declares.

import { mediaDevice, type MediaElement, type OutputNode, type StreamContext } from "../src/mediaDevice";
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

// ── stubs ─────────────────────────────────────────────────────────────────────────────

const SPEAKERS = { node: "speakers" };
const STREAM = { stream: "media stream" };

class StubGain implements OutputNode {
  connections: unknown[] = [];
  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.connections = [];
  }
}

class StubContext implements StreamContext {
  static last: StubContext | null = null;
  currentTime = 12.5;
  readonly destination = SPEAKERS;
  readonly calls: string[] = [];
  readonly gain = new StubGain();
  readonly streamNode = { stream: STREAM };
  constructor(readonly options: { readonly sampleRate: number }) {
    StubContext.last = this;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): PcmBuffer {
    return new StubBuffer(length, sampleRate);
  }
  createBufferSource(): PcmSource {
    return new StubSource();
  }
  createGain(): OutputNode {
    return this.gain;
  }
  createMediaStreamDestination(): { readonly stream: unknown } {
    return this.streamNode;
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

// An element whose next play is answered as the check says; a pause fires its event a task
// later, as a browser's does.
class StubElement implements MediaElement {
  srcObject: unknown = null;
  paused = true;
  answer: "plays" | "refuses" | "aborts" = "plays";
  readonly calls: string[] = [];
  readonly #listeners: Array<() => void> = [];
  play(): Promise<void> {
    this.calls.push("play");
    if (this.answer !== "plays") {
      const name = this.answer === "refuses" ? "NotAllowedError" : "AbortError";
      return Promise.reject(Object.assign(new Error(name), { name }));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.calls.push("pause");
    if (this.paused) return;
    this.paused = true;
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

// ── the checks ────────────────────────────────────────────────────────────────────────

console.log("mediaDevice: the context's sound leaves through the element");
{
  const { device, context, element } = rig();
  assert("the context is opened at the rate asked", context.options.sampleRate === 24_000);
  assert("sources connect to one output, whose one onward connection is the stream the element plays", device.destination === context.gain && context.gain.connections.length === 1 && context.gain.connections[0] === context.streamNode && element.srcObject === STREAM);
  assert("the clock is the context's", device.currentTime === 12.5);
  device.resume();
  assert("resume plays the element and resumes the context, both on the caller's stack", element.calls.join() === "play" && context.calls.join() === "resume" && !element.paused);
  void device.suspend();
  assert("suspend pauses the element with the context", element.calls.join() === "play,pause" && context.calls.join() === "resume,suspend" && element.paused);
}

console.log("mediaDevice: a pause the device did not ask for is said; its own are not");
{
  const { device, element, said } = rig();
  device.resume();
  void device.suspend();
  await tick();
  assert("the device's own pause: nothing said", said.interrupted === 0);
  void device.suspend();
  await tick();
  assert("a suspend over a paused element pauses nothing more, and counts nothing", said.interrupted === 0 && element.calls.filter((c) => c === "pause").length === 1);
  device.resume();
  element.platformPause();
  await tick();
  assert("the platform pausing the element: said once to the owner", said.interrupted === 1);
  void device.close();
  await tick();
  assert("close over the platform's pause: nothing more said, the element let go", said.interrupted === 1 && element.srcObject === null);
}

console.log("mediaDevice: a refused play puts the voice on the speakers");
{
  const { device, context, element, said } = rig();
  element.answer = "aborts";
  device.resume();
  await settle();
  assert("a play cut short by a pause is not a refusal: the output still reaches the element", said.refused.length === 0 && context.gain.connections[0] === context.streamNode);
  element.answer = "refuses";
  device.resume();
  await settle();
  assert("a refused play: the output moves to the speakers and the refusal is said", context.gain.connections.length === 1 && context.gain.connections[0] === SPEAKERS && said.refused.length === 1);
  device.resume();
  await settle();
  assert("from then on the context alone is resumed; the element is not asked again", element.calls.filter((c) => c === "play").length === 2 && context.calls.filter((c) => c === "resume").length === 3);
}

console.log(process.exitCode === 1 ? "media-device-check: FAILED" : "media-device-check: ok");
