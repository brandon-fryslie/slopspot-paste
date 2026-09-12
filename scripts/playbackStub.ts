// The stub playback device the unit player and the scheduler checks drive the real
// unitPlayer.ts over: a clock the check moves by hand and sources that record when they
// were started, with `ended` dispatched in end order as a real context would. Not a check
// itself (run-checks.ts discovers `*-check.ts`), so it is shared rather than copied
// [LAW:one-source-of-truth].
//
// [LAW:types-are-the-program] Implemented at exactly the seam the player declares —
// PlaybackDevice, PcmSource, PcmBuffer — and nothing more, so a player change that needs
// more of Web Audio fails to compile here before it fails in a browser.

import { MODEL_PCM } from "../src/unitPlayer";
import type { PcmBuffer, PcmSource, PlaybackDevice, PlayerState } from "../src/unitPlayer";

export const { sampleRate: SR, frameSamples: FS } = MODEL_PCM;
export const FRAME_S = FS / SR;

export class StubBuffer implements PcmBuffer {
  readonly data: Float32Array;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void {
    if (channel !== 0) throw new Error(`stub buffer: channel ${channel}`);
    this.data.set(source);
  }
}

export class StubSource implements PcmSource {
  buffer: PcmBuffer | null = null;
  // The rate the player started this source at, as a real AudioBufferSourceNode carries
  // it: a k-rate param whose `value` is read, never a plain number.
  readonly playbackRate = { value: 1 };
  onended: ((event: Event) => unknown) | null = null;
  connected: unknown = null;
  started: { readonly when: number; readonly offset: number } | null = null;
  stopped = false;
  ended = false;
  connect(destination: unknown): unknown {
    this.connected = destination;
    return destination;
  }
  start(when: number, offset: number): void {
    if (this.started !== null) throw new Error("stub source: started twice");
    this.started = { when, offset };
  }
  stop(): void {
    this.stopped = true;
  }
  // The context time this source's last sample ends. A source played faster ends sooner:
  // the buffer's own seconds divided by the rate it is resampled at, which is what the
  // player's schedule arithmetic assumes of the device.
  endTime(): number {
    if (this.started === null || !(this.buffer instanceof StubBuffer)) throw new Error("stub source: not started");
    return this.started.when + (this.buffer.length / this.buffer.sampleRate - this.started.offset) / this.playbackRate.value;
  }
}

export class StubDevice implements PlaybackDevice {
  static instances: StubDevice[] = [];
  currentTime = 0;
  readonly destination = { node: "destination" };
  readonly sampleRate: number;
  readonly calls: string[] = [];
  readonly sources: StubSource[] = [];
  constructor(options: { readonly sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    StubDevice.instances.push(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer {
    if (channels !== 1) throw new Error(`stub device: ${channels} channels`);
    return new StubBuffer(length, sampleRate);
  }
  createBufferSource(): PcmSource {
    const source = new StubSource();
    this.sources.push(source);
    return source;
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
  // Move the clock, then dispatch `ended` for every source that has finished or been
  // stopped, in end order — what a real context does asynchronously. The clock moves even
  // while "suspended", which is harsher than reality: a held position must not follow it.
  advance(seconds: number): void {
    this.currentTime += seconds;
    const due = this.sources
      .filter((s) => s.started !== null && !s.ended && (s.stopped || s.endTime() <= this.currentTime))
      .sort((a, b) => a.endTime() - b.endTime());
    for (const source of due) {
      source.ended = true;
      source.onended?.call(source, new Event("ended"));
    }
  }
  // Sources the context is still holding: started, not stopped, not ended.
  live(): StubSource[] {
    return this.sources.filter((s) => s.started !== null && !s.stopped && !s.ended);
  }
}

// One frame of test PCM, recognisable by its unit and index.
export const frame = (unit: number, index: number): Float32Array<ArrayBuffer> =>
  new Float32Array(new ArrayBuffer(FS * 4)).fill(unit * 100 + index + 1);

export const describe = (state: PlayerState): string =>
  state.kind === "idle"
    ? "idle"
    : `${state.kind}${state.kind === "speaking" ? `/${state.flow}` : ""}@${state.at.unitIndex}:${state.at.offsetMs.toFixed(3)}`;
