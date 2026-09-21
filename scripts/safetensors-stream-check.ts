// Streaming safetensors check (slopspot-read-along-i9a). One seam, driven over files this
// check builds in memory, with no mocks of anything [LAW:behavior-not-structure]:
// src/safetensorsStream.ts — the reader that turns a byte stream into whole tensors.
//
// The contract that matters is memory, and it is checked as behaviour rather than asserted
// in prose: a tensor is handed over the moment its last byte lands (so the stream is not
// quietly accumulating the file), and its bytes are its own buffer (so holding a tensor
// cannot pin the 24 MiB part it was cut from).
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────
//   the whole file in one chunk          -> every tensor, in file order, bytes equal
//   cut at every boundary that matters   -> same tensors, same bytes
//   (inside the length prefix, inside
//    the header, mid-tensor, byte by byte)
//   a tensor complete mid-chunk          -> handed over before the chunk is finished
//   padding between tensors              -> skipped, never handed to anyone
//   tensors listed out of order          -> read in offset order
//   __metadata__                         -> not a tensor
//   a chunk at the wrong offset          -> throws naming both offsets
//   a chunk past the end of the file     -> throws
//   finish() before the last byte        -> throws naming what is missing
//   a file of no bytes at all            -> throws
//   a header longer than the file        -> throws
//   a tensor ending past the file        -> throws naming the tensor
//   two tensors over the same bytes      -> throws naming the second
//   an entry without dtype/shape/offsets -> throws naming the tensor

import { createSafetensorsStream, type StreamedTensor } from "../src/safetensorsStream";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const threw = (run: () => void): string | null => {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// A safetensors file over the entries given, laid out in the order they are written.
// `gap` puts unclaimed bytes between two tensors, which the format allows and the stream
// must skip.
interface Entry {
  readonly name: string;
  readonly bytes: number;
  readonly gapAfter?: number;
}

const build = (entries: readonly Entry[], extra: Record<string, unknown> = {}): { file: Uint8Array<ArrayBuffer>; contents: Map<string, Uint8Array> } => {
  const header: Record<string, unknown> = { ...extra };
  const contents = new Map<string, Uint8Array>();
  let at = 0;
  for (const entry of entries) {
    header[entry.name] = { dtype: "F16", shape: [entry.bytes / 2], data_offsets: [at, at + entry.bytes] };
    const body = new Uint8Array(entry.bytes);
    // A pattern that differs per tensor and per position, so a misplaced byte shows.
    for (let i = 0; i < entry.bytes; i++) body[i] = (entry.name.charCodeAt(0) + i) & 0xff;
    contents.set(entry.name, body);
    at += entry.bytes + (entry.gapAfter ?? 0);
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const file = new Uint8Array(new ArrayBuffer(8 + json.byteLength + at));
  new DataView(file.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  file.set(json, 8);
  let cursor = 8 + json.byteLength;
  for (const entry of entries) {
    file.set(contents.get(entry.name) as Uint8Array, cursor);
    cursor += entry.bytes + (entry.gapAfter ?? 0);
  }
  return { file, contents };
};

// Feed a file through the stream in chunks of `size`, collecting what comes out.
const run = (file: Uint8Array<ArrayBuffer>, size: number): StreamedTensor[] => {
  const seen: StreamedTensor[] = [];
  const stream = createSafetensorsStream(file.byteLength, (tensor) => seen.push(tensor));
  for (let at = 0; at < file.byteLength; at += size) {
    stream.push(file.slice(at, Math.min(file.byteLength, at + size)) as Uint8Array<ArrayBuffer>, at);
  }
  stream.finish();
  return seen;
};

const same = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

console.log("whole tensors, however the bytes are cut:");
{
  const { file, contents } = build([
    { name: "alpha", bytes: 64 },
    { name: "beta", bytes: 1024, gapAfter: 8 },
    { name: "gamma", bytes: 2 },
    { name: "delta", bytes: 4096 },
  ]);
  const expected = [...contents.keys()];
  // Every chunking from one byte at a time to the whole file at once, plus sizes that land
  // inside the length prefix, inside the header and inside a tensor.
  const sizes = [1, 2, 3, 5, 7, 8, 9, 13, 64, 100, 511, 1024, 4096, file.byteLength];
  const wrong = sizes.filter((size) => {
    const seen = run(file, size);
    return seen.map((t) => t.name).join() !== expected.join() || seen.some((t) => !same(t.data, contents.get(t.name) as Uint8Array));
  });
  assert(`every tensor arrives whole and in file order at all ${sizes.length} chunkings`, wrong.length === 0);

  const seen = run(file, file.byteLength);
  assert("shapes and dtypes come through as the header spells them", seen.every((t) => t.dtype === "F16") && seen[0]?.shape.join() === "32");
  // The point of the module: a tensor's bytes are its own buffer, so a consumer that keeps
  // one is not keeping the part it came in.
  assert("each tensor's bytes are an exact-size buffer of their own", seen.every((t) => t.data.byteOffset === 0 && t.data.buffer.byteLength === t.data.byteLength));
  assert("the gap between two tensors is skipped, not handed over", seen.length === 4 && same(seen[1]!.data, contents.get("beta") as Uint8Array));
}

{
  // A tensor must be handed over as soon as its bytes are all in, not held back until the
  // file ends — that is the difference between one tensor resident and all of them.
  const { file } = build([{ name: "alpha", bytes: 64 }, { name: "beta", bytes: 4096 }]);
  const seen: string[] = [];
  const stream = createSafetensorsStream(file.byteLength, (t) => seen.push(t.name));
  const half = file.byteLength - 2048;
  stream.push(file.slice(0, half) as Uint8Array<ArrayBuffer>, 0);
  const early = seen.join();
  stream.push(file.slice(half) as Uint8Array<ArrayBuffer>, half);
  stream.finish();
  assert("a tensor whose bytes have landed is handed over before the file ends", early === "alpha" && seen.join() === "alpha,beta");
}

{
  const { file, contents } = build(
    [{ name: "alpha", bytes: 64 }, { name: "beta", bytes: 128 }],
    { __metadata__: { format: "pt" } },
  );
  const seen = run(file, 37);
  assert("__metadata__ is not a tensor", seen.map((t) => t.name).join() === "alpha,beta" && same(seen[0]!.data, contents.get("alpha") as Uint8Array));
}

{
  // The header is a JSON object: nothing promises the entries are written in offset order,
  // and the bytes only arrive in one.
  const { file, contents } = build([{ name: "alpha", bytes: 64 }, { name: "beta", bytes: 128 }]);
  const length = Number(new DataView(file.buffer).getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + length))) as Record<string, unknown>;
  const reversed = new TextEncoder().encode(JSON.stringify({ beta: header["beta"], alpha: header["alpha"] }));
  const rebuilt = new Uint8Array(new ArrayBuffer(file.byteLength));
  rebuilt.set(file);
  rebuilt.set(reversed, 8);
  const seen = run(rebuilt as Uint8Array<ArrayBuffer>, 64);
  assert("tensors listed out of order are read in offset order", seen.map((t) => t.name).join() === "alpha,beta" && same(seen[0]!.data, contents.get("alpha") as Uint8Array));
}

console.log("a stream that cannot be trusted says so:");
{
  const { file } = build([{ name: "alpha", bytes: 64 }, { name: "beta", bytes: 128 }]);
  const outOfOrder = threw(() => {
    const stream = createSafetensorsStream(file.byteLength, () => {});
    stream.push(file.slice(0, 32) as Uint8Array<ArrayBuffer>, 0);
    stream.push(file.slice(64) as Uint8Array<ArrayBuffer>, 64);
  });
  assert("a chunk at the wrong offset throws naming both offsets", outOfOrder?.includes("at 64 where the stream is at 32") === true);

  const overrun = threw(() => {
    const stream = createSafetensorsStream(32, () => {});
    stream.push(file.slice(0, 64) as Uint8Array<ArrayBuffer>, 0);
  });
  assert("a chunk past the end of the file throws", overrun?.includes("of a 32-byte file") === true);

  const short = threw(() => {
    const stream = createSafetensorsStream(file.byteLength, () => {});
    stream.push(file.slice(0, file.byteLength - 4) as Uint8Array<ArrayBuffer>, 0);
    stream.finish();
  });
  assert("finish() before the last byte throws naming where it stopped", short?.includes(`of ${file.byteLength} bytes`) === true);

  // The file that ends before its header does: an asset of no bytes at all, which the
  // manifest could name and the loader would hand over as nothing.
  const empty = threw(() => createSafetensorsStream(0, () => {}).finish());
  assert("a file with no header at all throws", empty?.includes("inside its header") === true);
}

{
  const impossible = new Uint8Array(new ArrayBuffer(64));
  new DataView(impossible.buffer).setBigUint64(0, 1_000_000n, true);
  const message = threw(() => createSafetensorsStream(64, () => {}).push(impossible as Uint8Array<ArrayBuffer>, 0));
  assert("a header longer than the file throws before anything is allocated on its word", message?.includes("1000000-byte header") === true);
}

{
  const { file } = build([{ name: "alpha", bytes: 64 }]);
  const message = threw(() => createSafetensorsStream(file.byteLength - 8, () => {}).push(file.slice(0, file.byteLength - 8) as Uint8Array<ArrayBuffer>, 0));
  assert("a tensor ending past the file throws naming the tensor", message?.includes("tensor alpha ends at") === true);
}

{
  const { file } = build([{ name: "alpha", bytes: 64 }, { name: "beta", bytes: 64 }]);
  const length = Number(new DataView(file.buffer).getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + length))) as Record<string, { data_offsets: number[] }>;
  const overlapping = { ...header, beta: { ...header["beta"] as object, data_offsets: [32, 96] } };
  const json = new TextEncoder().encode(JSON.stringify(overlapping));
  const rebuilt = new Uint8Array(new ArrayBuffer(8 + json.byteLength + 128));
  new DataView(rebuilt.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  rebuilt.set(json, 8);
  const message = threw(() => createSafetensorsStream(rebuilt.byteLength, () => {}).push(rebuilt as Uint8Array<ArrayBuffer>, 0));
  assert("two tensors over the same bytes throws naming the second", message?.includes("tensor beta starts at") === true);
}

{
  const json = new TextEncoder().encode(JSON.stringify({ alpha: { dtype: "F16" } }));
  const file = new Uint8Array(new ArrayBuffer(8 + json.byteLength));
  new DataView(file.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  file.set(json, 8);
  const message = threw(() => createSafetensorsStream(file.byteLength, () => {}).push(file as Uint8Array<ArrayBuffer>, 0));
  assert("an entry without a shape and offsets throws naming the tensor", message?.includes("tensor alpha has no dtype, shape and data_offsets") === true);
}

if (process.exitCode === 1) console.error("\nsafetensors-stream-check: FAILED");
else console.log("\nsafetensors-stream-check: all passed");
