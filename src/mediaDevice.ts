// [LAW:decomposition] The audio device as a phone's media controls see it: an audio context,
// with a silent media element playing beside it while it sounds. One sentence, no "and"
// hiding a second job: this module opens a PlaybackDevice (unitPlayer.ts) that the platform
// counts as media. It schedules nothing, knows no unit and no position; the unit player
// borrows it exactly as it borrowed the bare context, through the same structural seam
// [LAW:composability].
//
// WHY A CARRIER. The lock screen, the media notification, a headset's buttons, and the pause a
// call makes belong to media elements, not to an AudioContext. A browser gives them only to
// an element playing something long enough to be content. Chrome counts an element playing a
// MediaStream as a one-shot sound that nobody controls (WebMediaPlayerMS reports its content
// as kOneShot, and MediaSessionImpl::IsControllable is false for a session with only those),
// and a file of five seconds or less as transient (media::DurationToMediaContentType). So the
// voice sounds from the context straight to the speakers, and beside it the element loops a
// silent file of CARRIER_SECONDS: that is what makes the page's media session the platform's.
//
// ONE CLOCK. The element is never a clock and carries no sound [LAW:one-source-of-truth]:
// `currentTime` is the context's and the schedule is the context's. The element plays exactly
// while the context runs for a listen — `resume` plays it, `suspend` and `close` pause it — so
// the lock screen never shows media playing that nobody hears, and a device standing ready
// holds none of the phone's audio.
//
// THE UNLOCK. A tap before the voice is on stage spends the reader's gesture on the device
// (`unlock`): the context is resumed on the tap's stack, and the element is primed — played
// and paused at once, before it has loaded a byte, so it takes no audio focus and shows no
// notification. That is what lets its real play, on a worker message many seconds later,
// start without a gesture on a browser that asks for one per element.
//
// WHEN THE PLATFORM TAKES IT. A phone pauses the element on its own — a call, another app
// taking the audio, headphones pulled out — and the context would sound on regardless. A pause
// the device did not ask for is therefore said to its owner (`interrupted`), who pauses the
// listen the way the reader would [LAW:no-silent-failure].
//
// WHEN THE ELEMENT REFUSES. The voice never went through the element, so a refused play
// silences nothing: the listen sounds without the lock screen, and the refusal is said
// (`refused`). The next play asks again.

import type { PcmBuffer, PcmSource, PlaybackDevice } from "./unitPlayer";

// [LAW:types-are-the-program] Exactly the surface of Web Audio and HTMLMediaElement this
// module uses, so the page's AudioContext and <audio> satisfy it structurally and the check's
// stubs implement nothing more.
export interface SoundContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer;
  createBufferSource(): PcmSource;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export interface MediaElement {
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "pause", listener: () => void): void;
}

export interface MediaDeviceConfig {
  // `AudioContext` in the page.
  readonly Context: new (options: { readonly sampleRate: number }) => SoundContext;
  // A fresh element per device, looping the silent carrier (`carrierWav`).
  readonly element: () => MediaElement;
  // The platform paused the element: the owner pauses the listen.
  readonly interrupted: () => void;
  // The element refused to play: the voice sounds without the lock screen.
  readonly refused: (error: unknown) => void;
}

// Longer than the five seconds under which Chrome counts a file as a transient sound.
export const CARRIER_SECONDS = 10;
const CARRIER_RATE = 8000;

// The carrier: CARRIER_SECONDS of silence as an 8-bit mono PCM WAV, 80 KB, built here rather
// than fetched, so the lock screen needs nothing from the network.
export const carrierWav = (): ArrayBuffer => {
  const samples = CARRIER_SECONDS * CARRIER_RATE;
  const bytes = new ArrayBuffer(44 + samples);
  const view = new DataView(bytes);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, CARRIER_RATE, true);
  view.setUint32(28, CARRIER_RATE, true); // bytes per second
  view.setUint16(32, 1, true); // bytes per frame
  view.setUint16(34, 8, true); // bits per sample
  tag(36, "data");
  view.setUint32(40, samples, true);
  // Unsigned 8-bit silence is the midpoint.
  new Uint8Array(bytes, 44).fill(128);
  return bytes;
};

const aborted = (error: unknown): boolean => typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

// A DeviceFactory (unitPlayer.ts) over a context with a carrier element beside it.
export const mediaDevice = (config: MediaDeviceConfig): new (options: { readonly sampleRate: number }) => PlaybackDevice =>
  class MediaDevice implements PlaybackDevice {
    readonly #context: SoundContext;
    readonly #element: MediaElement;
    // [LAW:no-shared-mutable-globals] Owned per device: whether the element has been primed,
    // and how many of its pause events are this device's own.
    #primed = false;
    #ownPauses = 0;

    constructor(options: { readonly sampleRate: number }) {
      this.#context = new config.Context(options);
      this.#element = config.element();
      this.#element.addEventListener("pause", () => {
        if (this.#ownPauses > 0) this.#ownPauses -= 1;
        else config.interrupted();
      });
    }

    get currentTime(): number {
      return this.#context.currentTime;
    }

    get destination(): unknown {
      return this.#context.destination;
    }

    createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer {
      return this.#context.createBuffer(channels, length, sampleRate);
    }

    createBufferSource(): PcmSource {
      return this.#context.createBufferSource();
    }

    // A play cut short by this device's own pause — the prime's, or a pause landing before
    // the file loaded — is not a refusal.
    #play(): void {
      this.#element.play().catch((error: unknown) => {
        if (!aborted(error)) config.refused(error);
      });
    }

    #pause(): void {
      if (this.#element.paused) return;
      this.#ownPauses += 1;
      this.#element.pause();
    }

    unlock(): Promise<void> {
      if (!this.#primed) {
        this.#primed = true;
        this.#play();
        this.#pause();
      }
      return this.#context.resume();
    }

    resume(): Promise<void> {
      this.#play();
      return this.#context.resume();
    }

    suspend(): Promise<void> {
      this.#pause();
      return this.#context.suspend();
    }

    close(): Promise<void> {
      this.#pause();
      return this.#context.close();
    }
  };
