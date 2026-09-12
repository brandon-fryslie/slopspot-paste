// [LAW:effects-at-boundaries] The browser edge that brings a pinned model asset onto the
// reader's device: fetch its parts, prove the bytes are the ones the manifest names, keep
// them in the origin-private file system so the next visit costs zero network bytes. The
// two effects — fetch and the store — are PARAMETERS, so scripts/model-assets-check.ts
// drives every arm with a stub of each and no mocks of anything else.
//
// The store is the one the chosen runtime already uses: @jax-js/loaders' OPFS instance,
// keyed by string. Our keys are the manifest's asset keys, so a cache entry can only mean
// the bytes published at that path; there is no second cache beside it, and the page's
// residency reading (modelResidency.ts) is the same store's listing under the same keys
// [LAW:one-source-of-truth].
//
// THE BYTES ARE PROVEN AT EVERY LOAD, WHICHEVER WAY THEY CAME. One `prove` — length, then
// SHA-256 against the manifest — stands between any bytes and the runtime: the network's
// before they are stored, the store's before they are used [LAW:single-enforcer]. A stored
// entry is therefore never trusted on its key: a truncated, corrupt or foreign file of the
// right size is a `corrupt` miss, downloaded again and replaced, and the outcome says so.
// The cost of proving the resident path is one SHA-256 over 239 MB, hardware-accelerated
// in every WebCrypto: 0.14 s for the weights in Chrome 152 on an M2 Max (the read from
// OPFS beside it, 0.19 s), against a model warm-up of seconds — and the read into memory it
// hashes is one the runtime needed anyway. Eviction is tolerated by construction: an absent
// entry is a miss like any other, re-downloaded with progress and reported as
// `origin: network`, never hidden.
//
// [LAW:no-silent-failure] Nothing here defaults past a problem. A part that fails to
// fetch, a short read, or a hash that does not match the manifest is a typed failure with
// no bytes attached — the runtime cannot be handed unverified weights. A store that cannot
// be read (quota, private mode) is NOT a failure of the download: the read's throw is the
// `unreadable` miss, the bytes are downloaded and returned, and `persisted` carries the
// store's message so the UI can say the next visit will download again.

import { opfs } from "@jax-js/loaders";
import { type ModelAsset, MODEL_ASSET_PREFIX, assetKey, shardPlan } from "./modelAssets";

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

// Why the store did not serve the asset: the reason a load went to the network, carried
// with the outcome so a download that replaced a broken copy is never mistaken for a first
// download. `corrupt` names what the stored bytes turned out to be.
export type Miss =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "corrupt"; readonly expected: string; readonly actual: string };

export type Persisted = { readonly kind: "written" } | { readonly kind: "failed"; readonly message: string };

// [LAW:types-are-the-program] Where the bytes came from, with exactly the facts that origin
// has: a store hit has nothing to persist; a network load has why the store missed and
// whether the store now holds the bytes.
export type Origin =
  | { readonly kind: "store" }
  | { readonly kind: "network"; readonly miss: Miss; readonly persisted: Persisted };

export interface LoadedAsset {
  readonly asset: ModelAsset;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly origin: Origin;
}

export type LoadOutcome =
  | { readonly ok: true; readonly loaded: LoadedAsset }
  | { readonly ok: false; readonly failure: AssetFailure };

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
const prove = async (data: Uint8Array<ArrayBuffer>, asset: ModelAsset): Promise<Proof> => {
  const actual = data.byteLength === asset.bytes ? await sha256Hex(data) : `${data.byteLength} of ${asset.bytes} bytes`;
  return actual === asset.sha256 ? { ok: true } : { ok: false, actual };
};

// The store's word on one asset: proven bytes, or the miss that sends the load to the
// network. A read that throws is the store saying it cannot be read, not an empty store.
type Held = { readonly kind: "hit"; readonly data: Uint8Array<ArrayBuffer> } | Miss;
const fromStore = async (store: AssetStore, asset: ModelAsset): Promise<Held> => {
  let cached: Uint8Array<ArrayBuffer> | null;
  try {
    cached = await store.read(assetKey(asset));
  } catch (e) {
    return { kind: "unreadable", message: e instanceof Error ? e.message : String(e) };
  }
  if (cached === null) return { kind: "absent" };
  const proof = await prove(cached, asset);
  return proof.ok ? { kind: "hit", data: cached } : { kind: "corrupt", expected: asset.sha256, actual: proof.actual };
};

// One part, streamed straight into its slice of the asset's buffer — no per-part copy and
// no concatenation afterwards. `count` reports each chunk's size so the caller can sum
// progress across parts that download concurrently. Anything the transport throws —
// before the response or mid-stream — is the `network` failure.
const readPartInto = async (
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
  target: Uint8Array<ArrayBuffer>,
  count: (bytes: number) => void,
): Promise<{ ok: true; written: number } | { ok: false; failure: AssetFailure }> => {
  try {
    const response = await fetchLike(url, { signal });
    if (!response.ok || response.body === null) {
      return { ok: false, failure: { kind: "http", url, status: response.status } };
    }
    const reader = response.body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, written };
      // A server sending more than the planned range would overrun the slice; a short
      // read shows up as `written` under the range. Both land in the integrity check.
      const fit = Math.min(value.byteLength, target.byteLength - written);
      target.set(value.subarray(0, fit), written);
      written += fit;
      count(fit);
    }
  } catch (e) {
    return { ok: false, failure: { kind: "network", url, message: e instanceof Error ? e.message : String(e) } };
  }
};

// The whole path for one asset: proven store hit, else network → prove → store. Progress
// is the download's alone: a store hit reports none, since nothing was downloaded and a
// bar over it would be a lie; `loadAssets` says the last byte once, whatever served it.
export const loadAsset = async (
  asset: ModelAsset,
  io: AssetIo,
  onProgress: (p: AssetProgress) => void,
): Promise<LoadOutcome> => {
  const key = assetKey(asset);
  const totalBytes = asset.bytes;

  const held = await fromStore(io.store, asset);
  if (held.kind === "hit") return { ok: true, loaded: { asset, data: held.data, origin: { kind: "store" } } };

  const data = new Uint8Array(new ArrayBuffer(totalBytes));
  let loadedBytes = 0;
  onProgress({ loadedBytes, totalBytes });
  // The first part to fail is the cause; aborting the rest stops up to 200 MB of parts
  // that can no longer make a whole. Their own failures are consequences and are not reported.
  const abort = new AbortController();
  const failures: AssetFailure[] = [];
  await Promise.all(
    shardPlan(asset).map(async (shard) => {
      const part = await readPartInto(io.fetch, shard.url, abort.signal, data.subarray(shard.start, shard.end), (n) => {
        loadedBytes += n;
        onProgress({ loadedBytes, totalBytes });
      });
      if (!part.ok) {
        failures.push(part.failure);
        abort.abort();
      }
    }),
  );
  const cause = failures[0];
  if (cause !== undefined) return { ok: false, failure: cause };

  // The buffer is always the asset's length; a short part leaves it under-filled, which
  // `loadedBytes` sees and the hash would only confirm at the cost of a pass.
  const proof: Proof = loadedBytes === totalBytes ? await prove(data, asset) : { ok: false, actual: `short read: ${loadedBytes} of ${totalBytes} bytes` };
  if (!proof.ok) {
    return { ok: false, failure: { kind: "integrity", key, expected: asset.sha256, actual: proof.actual } };
  }

  let persisted: Persisted = { kind: "written" };
  try {
    await io.store.write(key, data);
  } catch (e) {
    persisted = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, loaded: { asset, data, origin: { kind: "network", miss: held, persisted } } };
};

export type LoadAllOutcome =
  | { readonly ok: true; readonly loaded: readonly LoadedAsset[] }
  | { readonly ok: false; readonly failure: AssetFailure };

// Several assets as one download with one progress bar: bytes are summed across the set
// so the UI shows "x of 239 MB", not ten resets, and a set the store already holds shows
// no bar at all. Assets load in order; parts within one asset load concurrently. The first
// failure stops the sequence and is reported as-is.
export const loadAssets = async (
  assets: readonly ModelAsset[],
  io: AssetIo,
  onProgress: (p: AssetProgress) => void,
): Promise<LoadAllOutcome> => {
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  // [LAW:single-enforcer] Each count is reported once: a network asset's last chunk and
  // the set's last word, a store hit's silence and the next asset's zero, each say a count
  // already said, and the repeat carries nothing.
  let reported = -1;
  const report = (loadedBytes: number): void => {
    if (loadedBytes === reported) return;
    reported = loadedBytes;
    onProgress({ loadedBytes, totalBytes });
  };
  const loaded: LoadedAsset[] = [];
  let doneBytes = 0;
  for (const asset of assets) {
    const outcome = await loadAsset(asset, io, (p) => report(doneBytes + p.loadedBytes));
    if (!outcome.ok) return outcome;
    loaded.push(outcome.loaded);
    doneBytes += asset.bytes;
  }
  // The last byte, on every path: the bar's end, and the panel's word that the warm-up is
  // next.
  report(totalBytes);
  return { ok: true, loaded };
};

// [LAW:carrying-cost] A new model build is a new key; the old 236 MB would otherwise sit
// in OPFS until the browser evicts it. Remove every entry under our prefix that the
// current manifest does not name. Returns what was removed so the caller can log it.
export const pruneStaleAssets = async (
  store: AssetStore,
  keep: readonly ModelAsset[],
): Promise<readonly string[]> => {
  const live = new Set(keep.map(assetKey));
  const stale = (await store.list())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(MODEL_ASSET_PREFIX) && !live.has(name));
  await Promise.all(stale.map((name) => store.remove(name)));
  return stale;
};
