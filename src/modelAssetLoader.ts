// [LAW:effects-at-boundaries] The browser edge that brings a pinned model asset onto the
// reader's device: fetch its parts, prove the bytes are the ones the manifest names, keep
// them in the origin-private file system so the next visit costs zero network bytes. The
// two effects — fetch and the store — are PARAMETERS, so scripts/model-assets-check.ts
// drives every arm with a stub of each and no mocks of anything else.
//
// The store is the one the chosen runtime already uses: @jax-js/loaders' OPFS instance,
// keyed by string. Our keys are the manifest's asset keys, so a cache entry can only mean
// the bytes published at that path; there is no second cache beside it
// [LAW:one-source-of-truth]. The hash is checked once, at the write [LAW:single-enforcer];
// a read trusts the key and checks only the size. Eviction is tolerated by construction: a
// missing or wrong-sized entry is re-downloaded with progress and reported as
// `origin: "network"`, never hidden.
//
// [LAW:no-silent-failure] Nothing here defaults past a problem. A part that fails to
// fetch, a short read, or a hash that does not match the manifest is a typed failure with
// no bytes attached — the runtime cannot be handed unverified weights. A store that cannot
// keep the bytes (quota, private mode) is NOT a failure of the download: a read that
// throws is a miss, the bytes are downloaded and returned, and `persisted` carries the
// store's message so the UI can say the next visit will download again.

import { opfs } from "@jax-js/loaders";
import { type ModelAsset, MODEL_ASSET_PREFIX, assetKey, shardPlan } from "./modelAssets";

// [LAW:types-are-the-program] The exact subset of @jax-js/loaders' OPFS the loader needs,
// stated structurally so the check's in-memory store and the real one are the same type.
export interface AssetStore {
  read(name: string): Promise<Uint8Array<ArrayBuffer> | null>;
  write(name: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
  list(): Promise<ReadonlyArray<{ readonly name: string }>>;
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

export type Persisted =
  | { readonly kind: "hit" }
  | { readonly kind: "written" }
  | { readonly kind: "failed"; readonly message: string };

export interface LoadedAsset {
  readonly asset: ModelAsset;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly origin: "store" | "network";
  readonly persisted: Persisted;
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

// The whole path for one asset: store hit, else network → verify → store.
export const loadAsset = async (
  asset: ModelAsset,
  io: AssetIo,
  onProgress: (p: AssetProgress) => void,
): Promise<LoadOutcome> => {
  const key = assetKey(asset);
  const totalBytes = asset.bytes;

  const cached = await io.store.read(key).catch(() => null);
  if (cached !== null && cached.byteLength === totalBytes) {
    onProgress({ loadedBytes: totalBytes, totalBytes });
    return { ok: true, loaded: { asset, data: cached, origin: "store", persisted: { kind: "hit" } } };
  }

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

  const actual = loadedBytes === totalBytes ? await sha256Hex(data) : `short read: ${loadedBytes} of ${totalBytes} bytes`;
  if (actual !== asset.sha256) {
    return { ok: false, failure: { kind: "integrity", key, expected: asset.sha256, actual } };
  }

  let persisted: Persisted = { kind: "written" };
  try {
    await io.store.write(key, data);
  } catch (e) {
    persisted = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, loaded: { asset, data, origin: "network", persisted } };
};

export type LoadAllOutcome =
  | { readonly ok: true; readonly loaded: readonly LoadedAsset[] }
  | { readonly ok: false; readonly failure: AssetFailure };

// Several assets as one download with one progress bar: bytes are summed across the set
// so the UI shows "x of 239 MB", not ten resets. Assets load in order; parts within one
// asset load concurrently. The first failure stops the sequence and is reported as-is.
export const loadAssets = async (
  assets: readonly ModelAsset[],
  io: AssetIo,
  onProgress: (p: AssetProgress) => void,
): Promise<LoadAllOutcome> => {
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  const loaded: LoadedAsset[] = [];
  let doneBytes = 0;
  for (const asset of assets) {
    const outcome = await loadAsset(asset, io, (p) => onProgress({ loadedBytes: doneBytes + p.loadedBytes, totalBytes }));
    if (!outcome.ok) return outcome;
    loaded.push(outcome.loaded);
    doneBytes += asset.bytes;
  }
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
