// [LAW:decomposition] The audio device as a phone sees media: an audio context whose output
// is played by a media element. One sentence, no "and" hiding a second job: this module
// opens a PlaybackDevice (unitPlayer.ts) whose sound leaves through an <audio> element. It
// schedules nothing, knows no unit and no position; the unit player borrows it exactly as it
// borrowed the bare context, through the same structural seam [LAW:composability].
//
// WHY AN ELEMENT. A phone's lock screen and its background audio belong to media elements:
// iOS gives a bare AudioContext neither, and Chrome on Android shows its media controls for
// a playing element. So the context renders into a MediaStream destination and an element
// plays that stream; the element is the page's media as the platform sees it, and nothing
// more.
//
// ONE CLOCK. The element is never a clock [LAW:one-source-of-truth]: `currentTime` is the
// context's, the schedule is the context's, and the element only carries what the context
// already rendered. It is started and stopped with the context — `resume` plays it on the
// caller's stack, which is the reader's gesture, the unlock both need; `suspend` pauses it —
// so it never plays a suspended context's silence as if the listen were on, and never sits
// paused while the context renders to nobody.
//
// WHEN THE PLATFORM TAKES IT. A phone pauses the element on its own — a call, another app
// taking the audio — while the context would render on into a stream nobody plays, the clock
// running through words nobody heard. A pause the device did not ask for is therefore said to
// its owner (`interrupted`), who pauses the listen the way the reader would
// [LAW:no-silent-failure].
//
// WHEN THE ELEMENT REFUSES. A play the browser refuses would leave the listen silent behind a
// running clock, so the output is moved to the context's own speakers and the refusal said
// (`refused`): the reader hears the voice without lock-screen controls rather than a voice
// that never sounds.

import type { PcmBuffer, PcmSource, PlaybackDevice } from "./unitPlayer";

// [LAW:types-are-the-program] Exactly the surface of Web Audio and HTMLMediaElement this
// module uses, so the page's AudioContext and <audio> satisfy it structurally and the check's
// stubs implement nothing more.
export interface OutputNode {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface StreamContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer;
  createBufferSource(): PcmSource;
  createGain(): OutputNode;
  createMediaStreamDestination(): { readonly stream: unknown };
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export interface MediaElement {
  srcObject: unknown;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "pause", listener: () => void): void;
}

export interface MediaDeviceConfig {
  // `AudioContext` in the page.
  readonly Context: new (options: { readonly sampleRate: number }) => StreamContext;
  // A fresh element per device: `() => new Audio()` in the page.
  readonly element: () => MediaElement;
  // The platform paused the element: the owner pauses the listen.
  readonly interrupted: () => void;
  // The element refused to play: the voice is on the speakers, without the lock screen.
  readonly refused: (error: unknown) => void;
}

const aborted = (error: unknown): boolean => typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

// A DeviceFactory (unitPlayer.ts) over a context played through an element.
export const mediaDevice = (config: MediaDeviceConfig): new (options: { readonly sampleRate: number }) => PlaybackDevice =>
  class MediaDevice implements PlaybackDevice {
    readonly #context: StreamContext;
    readonly #element: MediaElement;
    // Where every source connects: a node whose one onward connection is the stream the
    // element plays, or the speakers once the element has refused.
    readonly #output: OutputNode;
    // [LAW:no-shared-mutable-globals] Owned per device: whether the element refused, and how
    // many of the element's pause events are this device's own.
    #direct = false;
    #ownPauses = 0;

    constructor(options: { readonly sampleRate: number }) {
      this.#context = new config.Context(options);
      this.#element = config.element();
      this.#output = this.#context.createGain();
      const stream = this.#context.createMediaStreamDestination();
      this.#output.connect(stream);
      this.#element.srcObject = stream.stream;
      this.#element.addEventListener("pause", () => {
        if (this.#ownPauses > 0) this.#ownPauses -= 1;
        else config.interrupted();
      });
    }

    get currentTime(): number {
      return this.#context.currentTime;
    }

    get destination(): unknown {
      return this.#output;
    }

    createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer {
      return this.#context.createBuffer(channels, length, sampleRate);
    }

    createBufferSource(): PcmSource {
      return this.#context.createBufferSource();
    }

    resume(): Promise<void> {
      if (!this.#direct) {
        this.#element.play().catch((error: unknown) => {
          // A play cut short by this device's own pause is not a refusal: the next resume
          // plays again.
          if (aborted(error)) return;
          this.#direct = true;
          this.#output.disconnect();
          this.#output.connect(this.#context.destination);
          config.refused(error);
        });
      }
      return this.#context.resume();
    }

    #pause(): void {
      if (this.#element.paused) return;
      this.#ownPauses += 1;
      this.#element.pause();
    }

    suspend(): Promise<void> {
      this.#pause();
      return this.#context.suspend();
    }

    close(): Promise<void> {
      this.#pause();
      this.#element.srcObject = null;
      return this.#context.close();
    }
  };
