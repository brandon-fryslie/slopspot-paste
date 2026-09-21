// [LAW:effects-at-boundaries] The browser edge that brings a pinned model asset onto the
// reader's device: fetch its parts, prove the bytes are the ones the manifest names, keep
// them in the origin-private file system so the next visit costs zero network bytes. The
// two effects — fetch and the store — are PARAMETERS, so scripts/model-assets-check.ts
// drives every arm with a stub of each and no mocks of anything else.
//
// THE PART IS THE UNIT, OF EVERYTHING. A part is fetched, proven, stored, and handed on
// alone; no step here ever sees a whole asset. That is not an optimisation, it is what
// makes the model loadable on a phone: hashing is not a streaming operation in any browser,
// so proving a 236 MB asset as one thing means holding 236 MB to hash and another 236 MB
// for the hash to read, which is what killed the tab (slopspot-read-along-i9a). Pinned per
// part (modelAssets.ts `parts`), the same bytes are proven 24 MiB at a time, and the
// consumer — the runtime's streaming hydrator — takes each part as it lands and lets it go.
//
// The store is the one the chosen runtime already uses: @jax-js/loaders' OPFS instance,
// keyed by string. Our keys are the parts' own published paths, so a cache entry can only
// mean the bytes published at that path; there is no second cache beside it, and the page's
// residency reading (modelResidency.ts) is the same store's listing under the same keys
// [LAW:one-source-of-truth].
//
// THE BYTES ARE PROVEN AT EVERY LOAD, WHICHEVER WAY THEY CAME. One `prove` — length, then
// SHA-256 against the manifest's hash for that part — stands between any bytes and the
// consumer: the network's before they are stored, the store's before they are used
// [LAW:single-enforcer]. A stored entry is therefore never trusted on its key: a truncated,
// corrupt or foreign file of the right size is a `corrupt` miss, downloaded again and
// replaced, and the outcome says so. Eviction is tolerated by construction: an absent entry
// is a miss like any other, re-downloaded with progress and reported as `origin: network`,
// never hidden.
//
// [LAW:no-silent-failure] Nothing here defaults past a problem. A part that fails to fetch,
// a short read, or a hash that does not match the manifest is a typed failure with no bytes
// attached — the runtime cannot be handed unverified weights. A store that cannot be opened
// at all (private mode, a browser blocking site data) is NOT a failure of the download: the
// parts are proven and handed on exactly the same way, and only the keeping is lost. Every
// step that touches the store says its refusal as a value — the prune's `refused`, the
// read's `unreadable` miss, the write's `failed` persisted — and none of them throws past
// `loadAssets`, so the page's word for that store ("each listen downloads",
// modelResidency.ts) is a path the load really takes.

import { opfs } from "@jax-js/loaders";
import { type ModelAsset, type Shard, MODEL_ASSET_PREFIX, shardPlan } from "./modelAssets";

// [LAW:types-are-the-program] The exact subset of @jax-js/loaders' OPFS the loader needs,
// stated structurally so the check's in-memory store and the real one are the same type.
// `list` carries sizes: the residency reading is derived from them without a byte read.
export interface StoreEntry {
  readonly name: string;
  readonly size: number;
}

export interface AssetStore {
  read(name: string): Promise<Uint8Array<ArrayBuffer> | null>;
  write(name: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
  list(): Promise<ReadonlyArray<StoreEntry>>;
  remove(name: string): Promise<unknown>;
}

export type FetchLike = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

export interface AssetIo {
  readonly fetch: FetchLike;
  readonly store: AssetStore;
}

// The real edge, composed once: the page's fetch and the runtime's own OPFS store. The
// synthesis worker passes this; the check passes stubs of the same type.
export const browserAssetIo = (): AssetIo => ({ fetch: (url, init) => fetch(url, init), store: opfs });

export interface AssetProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export type AssetFailure =
  | { readonly kind: "http"; readonly url: string; readonly status: number }
  | { readonly kind: "network"; readonly url: string; readonly message: string }
  | { readonly kind: "integrity"; readonly key: string; readonly expected: string; readonly actual: string };

// Why the store did not serve a part: the reason a load went to the network, carried with
// the outcome so a download that replaced a broken copy is never mistaken for a first
// download. `corrupt` names what the stored bytes turned out to be.
export type Miss =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "corrupt"; readonly expected: string; readonly actual: string };

export type Persisted = { readonly kind: "written" } | { readonly kind: "failed"; readonly message: string };

// [LAW:types-are-the-program] Where an asset's bytes came from, with exactly the facts that
// origin has: every part served from the store has nothing to persist; an asset any part of
// which was downloaded carries why the store missed it and whether the store now holds it.
export type Origin =
  | { readonly kind: "store" }
  | { readonly kind: "network"; readonly miss: Miss; readonly persisted: Persisted };

// What a load can say about an asset once its last part has been handed on. There are no
// bytes here: they were the consumer's, one part at a time, and are gone
// [LAW:carrying-cost].
export interface LoadedAsset {
  readonly asset: ModelAsset;
  readonly origin: Origin;
}

export type LoadOutcome =
  | { readonly ok: true; readonly loaded: LoadedAsset }
  | { readonly ok: false; readonly failure: AssetFailure };

// [LAW:types-are-the-program] What the loader does with proven bytes: hands them to whoever
// asked for the asset, in file order, once each. The bytes are the sink's for the length of
// the call and the loader keeps no reference, so a sink that wants them later copies them —
// which is what lets a 236 MB asset cross this boundary 24 MiB at a time.
export type PartSink = (part: Uint8Array<ArrayBuffer>, shard: Shard, asset: ModelAsset) => Promise<void> | void;

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// [LAW:single-enforcer] The one proof that bytes are the manifest's. `actual` is what they
// were instead: their hash, or their length when even that is wrong (a hash of the wrong
// number of bytes could only disagree, and would cost a pass to say so).
type Proof = { readonly ok: true } | { readonly ok: false; readonly actual: string };
const prove = async (data: Uint8Array<ArrayBuffer>, shard: Shard): Promise<Proof> => {
  const size = shard.end - shard.start;
  const actual = data.byteLength === size ? await sha256Hex(data) : `${data.byteLength} of ${size} bytes`;
  return actual === shard.sha256 ? { ok: true } : { ok: false, actual };
};

// The store's word on one part: proven bytes, or the miss that sends the load to the
// network. A read that throws is the store saying it cannot be read, not an empty store.
type Held = { readonly kind: "hit"; readonly data: Uint8Array<ArrayBuffer> } | Miss;
const fromStore = async (store: AssetStore, shard: Shard): Promise<Held> => {
  let cached: Uint8Array<ArrayBuffer> | null;
  try {
    cached = await store.read(shard.url);
  } catch (e) {
    return { kind: "unreadable", message: e instanceof Error ? e.message : String(e) };
  }
  if (cached === null) return { kind: "absent" };
  const proof = await prove(cached, shard);
  return proof.ok ? { kind: "hit", data: cached } : { kind: "corrupt", expected: shard.sha256, actual: proof.actual };
};

// One part, streamed into its own buffer. `count` reports each chunk's size so the caller
// can show a bar that moves inside a part. Anything the transport throws — before the
// response or mid-stream — is the `network` failure.
const fetchPart = async (
  fetchLike: FetchLike,
  shard: Shard,
  signal: AbortSignal,
  count: (bytes: number) => void,
): Promise<{ ok: true; data: Uint8Array<ArrayBuffer> } | { ok: false; failure: AssetFailure }> => {
  const size = shard.end - shard.start;
  const target = new Uint8Array(new ArrayBuffer(size));
  try {
    const response = await fetchLike(shard.url, { signal });
    if (!response.ok || response.body === null) {
      return { ok: false, failure: { kind: "http", url: shard.url, status: response.status } };
    }
    const reader = response.body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, data: written === size ? target : target.subarray(0, written) };
      // A server sending more than the part's length would overrun the buffer; a short read
      // leaves it under-filled. Both land in the proof below as a length mismatch.
      const fit = Math.min(value.byteLength, size - written);
      target.set(value.subarray(0, fit), written);
      written += fit;
      count(fit);
    }
  } catch (e) {
    return { ok: false, failure: { kind: "network", url: shard.url, message: e instanceof Error ? e.message : String(e) } };
  }
};

// One part, proven, however it arrived, with what the store had to do with it.
interface Part {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly origin: Origin;
}
type PartOutcome = { readonly ok: true; readonly part: Part } | { readonly ok: false; readonly failure: AssetFailure };

const loadPart = async (
  shard: Shard,
  io: AssetIo,
  signal: AbortSignal,
  count: (bytes: number) => void,
): Promise<PartOutcome> => {
  const held = await fromStore(io.store, shard);
  if (held.kind === "hit") {
    // A stored part is in hand all at once, so its bytes are counted when it lands; a
    // downloaded one counts its chunks as they stream. Both say the same thing — how many
    // of this asset's bytes the load now holds — so the bar has one meaning
    // [LAW:one-type-per-behavior].
    count(held.data.byteLength);
    return { ok: true, part: { data: held.data, origin: { kind: "store" } } };
  }

  const fetched = await fetchPart(io.fetch, shard, signal, count);
  if (!fetched.ok) return { ok: false, failure: fetched.failure };
  const proof = await prove(fetched.data, shard);
  if (!proof.ok) {
    return { ok: false, failure: { kind: "integrity", key: shard.url, expected: shard.sha256, actual: proof.actual } };
  }
  let persisted: Persisted = { kind: "written" };
  try {
    await io.store.write(shard.url, fetched.data);
  } catch (e) {
    persisted = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, part: { data: fetched.data, origin: { kind: "network", miss: held, persisted } } };
};

// How many parts may be in flight at once. One is being proven and hydrated while the next
// is still arriving, so the link never idles through a hash; a third would buy nothing and
// cost another 24 MiB of the budget this whole module exists to protect
// [LAW:no-mode-explosion].
const IN_FLIGHT = 2;

// [LAW:one-source-of-truth] The asset's origin, derived from its parts rather than tracked
// beside them: an asset is the store's only if every part of it was, and the miss reported
// is the first part the store could not serve.
const originOf = (parts: readonly Origin[]): Origin => {
  const downloaded = parts.find((origin) => origin.kind === "network");
  if (downloaded === undefined) return { kind: "store" };
  const failure = parts.find((o): o is Extract<Origin, { kind: "network" }> => o.kind === "network" && o.persisted.kind === "failed");
  return { kind: "network", miss: downloaded.miss, persisted: failure?.persisted ?? { kind: "written" } };
};

// The whole path for one asset: each part proven from the store or from the network, in
// file order, handed to the sink and released. Parts are fetched one ahead of the sink, so
// the download overlaps the work the consumer does with the part before it
// [LAW:no-ambient-temporal-coupling] — the depth is stated here, never left to timing.
export const loadAsset = async (
  asset: ModelAsset,
  io: AssetIo,
  onProgress: (bytes: number) => void,
  sink: PartSink,
): Promise<LoadOutcome> => {
  const shards = shardPlan(asset);
  const abort = new AbortController();
  const inFlight: Promise<PartOutcome>[] = [];
  const origins: Origin[] = [];
  // THE FIRST FAILURE IN TIME IS THE CAUSE, and it is watched for rather than waited for.
  // Parts are consumed in file order but they fail in whatever order the network chooses,
  // so a part that hangs would sit in front of the part that already 404'd — and since the
  // hung one only ends when the abort fires, waiting in order is a deadlock, not a delay
  // [LAW:no-ambient-temporal-coupling]. Every part is therefore watched the moment it is
  // started: the first to fail names the cause and aborts the rest, whose own failures are
  // consequences of it.
  const cause: { failure: AssetFailure | null } = { failure: null };
  const start = (index: number): void => {
    const shard = shards[index];
    if (shard === undefined) return;
    const pending = loadPart(shard, io, abort.signal, onProgress);
    void pending.then((outcome) => {
      if (outcome.ok || cause.failure !== null) return;
      cause.failure = outcome.failure;
      // Aborting stops up to 200 MB of parts that can no longer make a whole.
      abort.abort();
    });
    inFlight.push(pending);
  };
  for (let i = 0; i < Math.min(IN_FLIGHT, shards.length); i++) start(i);

  // Every part already in flight settles before we leave, so none of them rejects into
  // nowhere after the caller has been told why the load failed.
  const stop = async (): Promise<void> => {
    abort.abort();
    await Promise.allSettled(inFlight);
  };

  for (const [index, shard] of shards.entries()) {
    const pending = inFlight[index];
    if (pending === undefined) throw new RangeError(`part ${index} of ${asset.name} was never started`);
    const outcome = await pending;
    const failure = cause.failure ?? (outcome.ok ? null : outcome.failure);
    if (failure !== null) {
      await stop();
      return { ok: false, failure };
    }
    if (!outcome.ok) throw new RangeError(`part ${index} of ${asset.name} failed without a cause`);
    start(index + IN_FLIGHT);
    origins.push(outcome.part.origin);
    try {
      await sink(outcome.part.data, shard, asset);
    } catch (e) {
      await stop();
      throw e;
    }
  }
  return { ok: true, loaded: { asset, origin: originOf(origins) } };
};

export type LoadAllOutcome =
  | { readonly ok: true; readonly loaded: readonly LoadedAsset[]; readonly pruning: Pruning }
  | { readonly ok: false; readonly failure: AssetFailure };

// The whole model onto the device, as one download with one progress bar. `assets` is the
// build's WHOLE set, never a part of it: every other entry under the prefix is an earlier
// build's copy, pruned first so its quota is free before the new bytes land; then bytes are
// summed across the set so the UI shows "x of 239 MB", not ten resets. Assets load in
// order, and so do the parts within one. The first failure stops the sequence and is
// reported as-is.
export const loadAssets = async (
  assets: readonly ModelAsset[],
  io: AssetIo,
  onProgress: (p: AssetProgress) => void,
  sink: PartSink,
): Promise<LoadAllOutcome> => {
  const pruning = await pruneStaleAssets(io.store, assets);
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  // [LAW:single-enforcer] Each count is reported once: the set's last word and a part's
  // last chunk would otherwise say the same number twice, and the repeat carries nothing.
  let reported = -1;
  let loadedBytes = 0;
  const report = (): void => {
    if (loadedBytes === reported) return;
    reported = loadedBytes;
    onProgress({ loadedBytes, totalBytes });
  };
  report();
  const loaded: LoadedAsset[] = [];
  for (const asset of assets) {
    const outcome = await loadAsset(
      asset,
      io,
      (bytes) => {
        loadedBytes += bytes;
        report();
      },
      sink,
    );
    if (!outcome.ok) return outcome;
    loaded.push(outcome.loaded);
  }
  return { ok: true, loaded, pruning };
};

// [LAW:types-are-the-program] What a prune did: the stale keys it removed, or the store's
// refusal to be listed or cleared. A refusal costs quota at most — the stale copies stay
// until the browser evicts them — and never the load, so it is a value, not a throw
// [LAW:no-silent-failure].
export type Pruning =
  | { readonly kind: "pruned"; readonly removed: readonly string[] }
  | { readonly kind: "refused"; readonly message: string };

// [LAW:carrying-cost] A new model build is a new set of part keys; the old 236 MB would
// otherwise sit in OPFS until the browser evicts it. Remove every entry under our prefix
// that the current manifest's cut does not name. Never rejects.
export const pruneStaleAssets = async (store: AssetStore, keep: readonly ModelAsset[]): Promise<Pruning> => {
  const live = new Set(keep.flatMap((asset) => shardPlan(asset).map((shard) => shard.url)));
  try {
    const stale = (await store.list())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(MODEL_ASSET_PREFIX) && !live.has(name));
    await Promise.all(stale.map((name) => store.remove(name)));
    return { kind: "pruned", removed: stale };
  } catch (e) {
    return { kind: "refused", message: e instanceof Error ? e.message : String(e) };
  }
};
