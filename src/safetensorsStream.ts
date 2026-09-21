// [LAW:decomposition] A safetensors file read as it arrives: bytes go in as chunks, whole
// tensors come out. One sentence, no "and" — this module turns a byte stream into tensors
// and nothing else. It fetches nothing, allocates no device memory and knows no model: the
// runtime (pocketTtsRuntime.ts) decides what to do with each tensor, and the loader
// (modelAssetLoader.ts) decides where the bytes came from [LAW:effects-at-boundaries]. So
// it is pure, and scripts/safetensors-stream-check.ts drives every arm over a file it
// builds in memory, cut at every boundary that matters.
//
// WHY THIS EXISTS. @jax-js/loaders' `safetensors.parse` takes the whole file as one buffer,
// which for the 236 MB checkpoint means the reader's device holds 236 MB of JS memory
// before a single weight reaches the GPU — and, with the copy the hash needs beside it,
// that is what killed a phone's tab (slopspot-read-along-i9a). The file's own layout makes
// the whole buffer unnecessary: a header of byte ranges, then the ranges. Fed in order, a
// tensor can be handed over the moment its last byte lands and forgotten immediately, so
// what is held at once is one chunk and one tensor — 41 MB at this build's worst, against
// 236 MB.
//
// WHY THE CHUNKS CARRY THEIR OWN OFFSET. The caller already knows where each chunk sits in
// the file — it is the part's range in the manifest's cut — so the stream is told rather
// than left to count, and a caller that skips or repeats a chunk is a thrown error instead
// of a silently mis-assembled tensor [LAW:no-silent-failure].

// [LAW:types-are-the-program] One tensor, complete: its name as the file spells it, and the
// bytes of exactly that tensor. `data` is the stream's own buffer and is handed over — the
// stream keeps no reference, so the consumer may hold it or let it go.
export interface StreamedTensor {
  readonly name: string;
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly data: Uint8Array<ArrayBuffer>;
}

export interface SafetensorsStream {
  // The next bytes of the file, at the offset they occupy in it. Chunks must arrive in
  // order and leave no hole.
  readonly push: (chunk: Uint8Array<ArrayBuffer>, at: number) => void;
  // The file is over: every tensor the header named has been handed over, or this throws.
  readonly finish: () => void;
}

interface Planned {
  readonly name: string;
  readonly dtype: string;
  readonly shape: readonly number[];
  // Absolute offsets in the file, not in the data section.
  readonly start: number;
  readonly end: number;
}

// The eight little-endian bytes the format opens with: how long the JSON header is.
const HEADER_LENGTH_BYTES = 8;

// A header claiming to be gigabytes is a file that is not a safetensors file — read as a
// length before anything is allocated on its word [LAW:parse-dont-validate].
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

interface RawEntry {
  readonly dtype: unknown;
  readonly shape: unknown;
  readonly data_offsets: unknown;
}

// [LAW:parse-dont-validate] The header, turned into the one thing the rest of this module
// reads: every tensor's absolute byte range, in the order the file lays them out. Anything
// the format does not allow — a range outside the file, a pair that is not two numbers, two
// tensors over the same bytes — is thrown here, where the file is still nothing but bytes,
// rather than surfacing later as a weight of the wrong shape.
const planOf = (header: string, dataStart: number, fileBytes: number): readonly Planned[] => {
  const parsed: unknown = JSON.parse(header);
  if (typeof parsed !== "object" || parsed === null) throw new Error("safetensors: the header is not an object");
  const planned: Planned[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    // The format's one reserved key: free-form strings about the file, not a tensor.
    if (name === "__metadata__") continue;
    const entry = value as RawEntry;
    const offsets = entry.data_offsets;
    if (typeof entry.dtype !== "string" || !Array.isArray(entry.shape) || !Array.isArray(offsets) || offsets.length !== 2) {
      throw new Error(`safetensors: tensor ${name} has no dtype, shape and data_offsets pair`);
    }
    const [from, to] = offsets as [unknown, unknown];
    if (typeof from !== "number" || typeof to !== "number" || !(from >= 0) || !(to >= from)) {
      throw new Error(`safetensors: tensor ${name} has data_offsets [${String(from)}, ${String(to)}]`);
    }
    const start = dataStart + from;
    const end = dataStart + to;
    if (end > fileBytes) {
      throw new Error(`safetensors: tensor ${name} ends at ${end} of a ${fileBytes}-byte file`);
    }
    planned.push({ name, dtype: entry.dtype, shape: entry.shape as readonly number[], start, end });
  }
  planned.sort((a, b) => a.start - b.start || a.end - b.end);
  let reach = dataStart;
  for (const tensor of planned) {
    if (tensor.start < reach) {
      throw new Error(`safetensors: tensor ${tensor.name} starts at ${tensor.start}, inside the tensor before it`);
    }
    reach = tensor.end;
  }
  return planned;
};

// What the stream is doing with the bytes it is handed: still reading the header, or
// filling tensors from the plan the header gave. [LAW:dataflow-not-control-flow] the phase
// is a value the same `push` reads every time, not two code paths a caller chooses between.
type Phase =
  | { readonly kind: "header"; readonly seen: Uint8Array<ArrayBuffer>; readonly filled: number }
  | { readonly kind: "tensors"; readonly plan: readonly Planned[] };

export const createSafetensorsStream = (
  fileBytes: number,
  onTensor: (tensor: StreamedTensor) => void,
): SafetensorsStream => {
  // Enough of the file's front to hold the length prefix and, once that is known, the JSON
  // header itself. Grown exactly once, to the length the file states.
  let phase: Phase = { kind: "header", seen: new Uint8Array(new ArrayBuffer(HEADER_LENGTH_BYTES)), filled: 0 };
  // Where the next byte the stream expects sits in the file: the one guard against a caller
  // that skips, repeats or reorders a chunk.
  let expected = 0;
  // The tensor being filled and how much of it has landed. A tensor that fits inside one
  // chunk is filled and handed over without ever being partial.
  let cursor = 0;
  let filling: Uint8Array<ArrayBuffer> | null = null;

  const readHeader = (bytes: Uint8Array<ArrayBuffer>): Phase => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = Number(view.getBigUint64(0, true));
    if (!(length > 0) || length > MAX_HEADER_BYTES || HEADER_LENGTH_BYTES + length > fileBytes) {
      throw new Error(`safetensors: a ${length}-byte header in a ${fileBytes}-byte file`);
    }
    if (bytes.byteLength < HEADER_LENGTH_BYTES + length) {
      const grown = new Uint8Array(new ArrayBuffer(HEADER_LENGTH_BYTES + length));
      grown.set(bytes);
      return { kind: "header", seen: grown, filled: bytes.byteLength };
    }
    const header = new TextDecoder().decode(bytes.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + length));
    return { kind: "tensors", plan: planOf(header, HEADER_LENGTH_BYTES + length, fileBytes) };
  };

  // The front of the file, in two bites from however many chunks it takes: the length
  // prefix, then the JSON the prefix sized. Returns how much of this chunk the header ate,
  // so whatever follows it in the same chunk goes on to the tensors.
  const fillHeader = (chunk: Uint8Array<ArrayBuffer>): number => {
    let taken = 0;
    while (phase.kind === "header" && taken < chunk.byteLength) {
      const state = phase;
      const wanted = Math.min(state.seen.byteLength - state.filled, chunk.byteLength - taken);
      state.seen.set(chunk.subarray(taken, taken + wanted), state.filled);
      taken += wanted;
      const filled = state.filled + wanted;
      phase = filled < state.seen.byteLength ? { ...state, filled } : readHeader(state.seen);
    }
    return taken;
  };

  const fillTensors = (plan: readonly Planned[], chunk: Uint8Array<ArrayBuffer>, at: number): void => {
    const chunkEnd = at + chunk.byteLength;
    let pos = at;
    while (cursor < plan.length && pos < chunkEnd) {
      const tensor = plan[cursor] as Planned;
      if (tensor.start >= chunkEnd) return;
      // Bytes between two tensors are the format's padding: skipped, never collected.
      const from = Math.max(pos, tensor.start);
      const to = Math.min(chunkEnd, tensor.end);
      const size = tensor.end - tensor.start;
      // A tensor that arrives whole inside this chunk still gets its own buffer: the chunk
      // is the loader's, and handing out a view of it would keep a 24 MiB part alive for
      // every tensor cut from it [LAW:carrying-cost].
      const buffer = filling ?? new Uint8Array(new ArrayBuffer(size));
      buffer.set(chunk.subarray(from - at, to - at), from - tensor.start);
      if (to < tensor.end) {
        filling = buffer;
        return;
      }
      filling = null;
      cursor += 1;
      onTensor({ name: tensor.name, dtype: tensor.dtype, shape: tensor.shape, data: buffer });
      pos = to;
    }
  };

  return {
    push: (chunk, at) => {
      if (at !== expected) {
        throw new Error(`safetensors: a chunk at ${at} where the stream is at ${expected}`);
      }
      if (at + chunk.byteLength > fileBytes) {
        throw new Error(`safetensors: a chunk ending at ${at + chunk.byteLength} of a ${fileBytes}-byte file`);
      }
      expected = at + chunk.byteLength;
      let taken = 0;
      // The header can end inside this chunk, so the same chunk feeds both phases: the
      // header takes what it needs and the tensors take the rest.
      if (phase.kind === "header") taken = fillHeader(chunk);
      if (phase.kind === "tensors" && taken < chunk.byteLength) {
        fillTensors(phase.plan, chunk.subarray(taken), at + taken);
      }
    },
    finish: () => {
      if (expected !== fileBytes) {
        throw new Error(`safetensors: the file ended at ${expected} of ${fileBytes} bytes`);
      }
      if (phase.kind === "header") throw new Error("safetensors: the file ended inside its header");
      if (cursor !== phase.plan.length) {
        throw new Error(`safetensors: ${phase.plan.length - cursor} of ${phase.plan.length} tensors never completed`);
      }
    },
  };
};
