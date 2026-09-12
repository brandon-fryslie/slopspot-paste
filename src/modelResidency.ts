// [LAW:decomposition] Model residency: what the reader's device holds of the model before
// any tap, and whether the browser will keep it. One sentence, no "and" — this module
// answers two questions about the store, and performs nothing else: it fetches no byte
// (modelAssetLoader.ts), spawns no worker, touches no GPU. The page reads it at mount, so
// "the voice is on this device" or "239 MB to download" is on the status line before the
// reader decides anything [LAW:no-silent-failure].
//
// [LAW:one-source-of-truth] Residency is derived from THE store the loader reads and writes,
// through THE keys the manifest derives: the directory listing the loader's own store
// returns, matched against modelAssets.assetKey. There is no second cache, no "downloaded"
// flag beside the bytes that could outlive them — the browser evicts the bytes, the next
// listing says `absent`, and nothing had to be told.
//
// WHAT `resident` CLAIMS, AND WHAT IT DOES NOT. A listing carries names and sizes, not
// bytes; hashing 236 MB on every page view for a status line would cost every reader a
// read they may never need. So `resident` is the directory's word — every asset the
// manifest names is listed at its size — and the BYTES are proven at load: the loader
// hashes what it reads back against the manifest, and a right-sized entry with the wrong
// bytes is replaced there, reported as a download. The two facts are stated by their two
// owners; neither is a copy of the other [FRAMING:representation].
//
// [LAW:effects-at-boundaries] The derivation is pure over a listing; the two effects — the
// store's listing and the browser's persistence request — are parameters, taken at the two
// thin edges below, so scripts/model-assets-check.ts drives every arm with the in-memory
// store and a stub of the request.

import type { StoreEntry } from "./modelAssetLoader";
import { type ModelAsset, assetKey } from "./modelAssets";

// [LAW:types-are-the-program] The three things a store can say about the model. `absent`
// carries the bytes still to download, because a store may hold some assets and not others
// (an interrupted first listen, an evicted weights file beside its voices): a number, never
// a bool. `unavailable` is the store that cannot be opened at all — private browsing, quota,
// no origin-private file system — with the browser's own reason.
export type Residency =
  | { readonly kind: "resident" }
  | { readonly kind: "absent"; readonly bytesToDownload: number }
  | { readonly kind: "unavailable"; readonly message: string };

// The pure derivation: an asset is held when the listing has its key at its size. Entries
// the manifest does not name — a stale build's, another tool's — are simply not asked about;
// the loader prunes the stale ones before its next write.
export const residencyOf = (listing: ReadonlyArray<StoreEntry>, assets: readonly ModelAsset[]): Residency => {
  const held = new Map(listing.map((entry) => [entry.name, entry.size]));
  const bytesToDownload = assets.filter((asset) => held.get(assetKey(asset)) !== asset.bytes).reduce((sum, asset) => sum + asset.bytes, 0);
  return bytesToDownload === 0 ? { kind: "resident" } : { kind: "absent", bytesToDownload };
};

// The one edge to the store: the listing, or the reason there is none.
// [LAW:parse-dont-validate] A throw here is the store's `unavailable` arm, typed, not a
// missing-arm null.
export const readResidency = async (
  store: { list(): Promise<ReadonlyArray<StoreEntry>> },
  assets: readonly ModelAsset[],
): Promise<Residency> => {
  try {
    return residencyOf(await store.list(), assets);
  } catch (e) {
    return { kind: "unavailable", message: e instanceof Error ? e.message : String(e) };
  }
};

// [LAW:types-are-the-program] The browser's answer to "keep these bytes": granted, denied —
// the honest consequence of which is that the voice may be dropped under storage pressure
// and downloaded again — or a request that threw. Never a silent denial
// [LAW:no-silent-failure].
export type Keeping =
  | { readonly kind: "granted" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly message: string };

// The one edge to the browser's persistence request (navigator.storage.persist, a Window-
// only API, so the page asks, not the worker). Asked at the moment of the reader's consent to
// download — the tap that sends `load` — and asked again on every later load: the answer can
// change with the site's engagement, and the request is idempotent.
export const askToKeep = async (persist: () => Promise<boolean>): Promise<Keeping> => {
  try {
    return (await persist()) ? { kind: "granted" } : { kind: "denied" };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
};
