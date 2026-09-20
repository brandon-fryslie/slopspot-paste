// Model-asset hosting check (slopspot-read-along-q35.cee). Three seams, driven with
// stubbed effects and no mocks of anything else [LAW:behavior-not-structure]:
//
//  1. src/modelAssets.ts — the manifest and its derivations. The shard plan must tile an
//     asset exactly under the static-asset file ceiling; addresses and MODEL_VERSION must
//     change when, and only when, the bytes do.
//  2. src/modelAssetLoader.ts — the browser edge. A network download reports byte-level
//     progress, verifies the hash, and persists; a second load fetches ZERO parts; a
//     wrong byte, a short read, an HTTP error or a transport error is a typed failure
//     with no bytes; a store that cannot write is reported, not hidden; stale entries
//     are pruned.
//  3. scripts/modelAssetMirror.ts — the deploy-time mirror against a temp directory: a
//     correct mirror fetches nothing; a missing or wrong-sized part refetches; a wrong
//     hash or a fetch that throws aborts by asset name; parts no plan names are removed.
//  4. public/_headers — the published cache and CORS rule — and .gitignore's mirror
//     directory, both keyed on the same prefix.
//
// ─── loadAsset ACCEPT TABLE ──────────────────────────────────────────────────
//   store has key, bytes prove         -> ok, origin store, 0 fetches
//   store empty, parts correct         -> ok, origin network (miss absent), persisted
//                                         written, stored
//   store empty, a byte flipped        -> integrity failure, nothing stored
//   store empty, a part truncated      -> integrity failure (short read), nothing stored
//   a part 404s                        -> http failure naming the url, nothing stored,
//                                         the other parts aborted
//   a part's fetch rejects             -> network failure naming the url, nothing stored
//   a part's body errors mid-stream    -> network failure naming the url, nothing stored
//   store.write throws                 -> ok with persisted failed{message}; bytes returned
//   store.read throws                  -> miss unreadable{message}: downloaded, persisted
//                                         failed{message}
//   store has key at the WRONG size    -> miss corrupt naming the size: re-downloaded, replaced
//   store has key, right size, wrong   -> miss corrupt naming the hash: re-downloaded,
//   bytes                                 replaced, never used
//
// ─── residency (modelResidency.ts) ──────────────────────────────────────────
//   every asset listed at its size     -> resident
//   one asset short (or absent)        -> absent, bytesToDownload = that asset's bytes
//   a stale key beside the live ones   -> resident; prune removes the stale key only
//
// ─── loadAssets (the set) ────────────────────────────────────────────────────
//   a stale key beside the set         -> pruned first, naming only that key
//   the store refuses everything       -> ok in memory: prune refused, every asset miss
//                                         unreadable, persisted failed
//   the store refuses a removal        -> ok and kept: prune refused
//   the store throws on list           -> unavailable with the store's message
//   persist resolves true / false /    -> keeping granted / denied / failed{message}
//   throws

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORTED_VOICE_DIR,
  MODEL_ASSETS,
  MODEL_ASSET_PREFIX,
  MODEL_VERSION,
  SHARD_BYTES,
  VOICE_IDS,
  allModelAssets,
  assetKey,
  downloadNeedsTap,
  exportedVoiceFile,
  modelVersion,
  SHA_PREFIX_CHARS,
  shardPlan,
  type Checkpoint,
  type ModelAsset,
} from "../src/modelAssets";
import { loadAsset, loadAssets, pruneStaleAssets, type AssetStore } from "../src/modelAssetLoader";
import { askToKeep, readResidency, residencyOf } from "../src/modelResidency";
import { mirror, mirrorIsCorrect, pruneStaleParts, readSource } from "./modelAssetMirror";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── 1. manifest ───────────────────────────────────────────────────────────────
console.log("manifest:");
const assets = allModelAssets(MODEL_ASSETS);
assert("every asset has a 64-hex sha256 and a positive size", assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0));
assert("asset names are unique", new Set(assets.map((a) => a.name)).size === assets.length);
assert("every voice id has an asset", VOICE_IDS.every((id) => MODEL_ASSETS.voices[id].name === `voice-${id}`));
assert("no voice is CC-BY-NC (only MIT, CC0, CC-BY-4.0 appear)", assets.every((a) => ["MIT", "CC0-1.0", "CC-BY-4.0"].includes(a.licence)));
assert("shard size is under the 25 MiB static-asset ceiling", SHARD_BYTES < 25 * 1024 * 1024);

// The one invariant that keeps the checked-in exports honest: a voice the manifest says is
// exported must be in the repo, at the path its own hash names, holding exactly those bytes.
// Without this the first sign of a missed re-export would be a failed deploy.
const exportedVoices = VOICE_IDS.map((id) => MODEL_ASSETS.voices[id]).filter((asset) => asset.source.kind === "exported");
for (const asset of exportedVoices) {
  const path = new URL(`../${exportedVoiceFile(asset)}`, import.meta.url);
  const bytes = existsSync(path) ? readFileSync(path) : null;
  assert(`${asset.name}: ${exportedVoiceFile(asset)} holds the ${asset.bytes} bytes the manifest pins`, bytes !== null && bytes.byteLength === asset.bytes && createHash("sha256").update(bytes).digest("hex") === asset.sha256);
}
assert("every exported voice is one part, so its repo file is the whole asset", exportedVoices.every((asset) => shardPlan(asset).length === 1));

for (const asset of assets) {
  const plan = shardPlan(asset);
  const tiles = plan.every((s, i) => s.start === (i === 0 ? 0 : plan[i - 1]!.end) && s.end > s.start && s.end - s.start <= SHARD_BYTES);
  assert(`${asset.name}: ${plan.length} part(s) tile [0, ${asset.bytes}) exactly`, tiles && plan[plan.length - 1]!.end === asset.bytes);
  assert(`${asset.name}: every part url is under ${MODEL_ASSET_PREFIX} and carries the sha prefix`, plan.every((s) => s.url.startsWith(assetKey(asset) + ".part") && assetKey(asset).includes(asset.sha256.slice(0, SHA_PREFIX_CHARS))));
}
assert("weights need more than one part; tokenizer needs exactly one", shardPlan(MODEL_ASSETS.weights).length > 1 && shardPlan(MODEL_ASSETS.tokenizer).length === 1);

const rehashed: Checkpoint = { ...MODEL_ASSETS.weights, sha256: "f".repeat(64) };
assert("new bytes are a new url", assetKey(rehashed) !== assetKey(MODEL_ASSETS.weights));
assert("new bytes change MODEL_VERSION", modelVersion({ ...MODEL_ASSETS, weights: rehashed }) !== MODEL_VERSION);
assert("same bytes keep MODEL_VERSION", modelVersion({ ...MODEL_ASSETS }) === MODEL_VERSION);
assert("MODEL_VERSION names every asset", assets.every((a) => MODEL_VERSION.includes(`${a.name}@`)));

console.log("metered policy:");
assert("save-data needs a tap", downloadNeedsTap({ saveData: true }));
assert("cellular needs a tap", downloadNeedsTap({ type: "cellular" }));
assert("wifi does not", !downloadNeedsTap({ type: "wifi", saveData: false }));
assert("unknown (no API) does not", !downloadNeedsTap(undefined));

// ── 2. loader ─────────────────────────────────────────────────────────────────
console.log("loader:");

// A synthetic asset spanning two full parts and a tail, filled with a cheap pattern.
const SYNTH_BYTES = 2 * SHARD_BYTES + 12345;
const synthData = new Uint8Array(new ArrayBuffer(SYNTH_BYTES));
for (let i = 0; i < SYNTH_BYTES; i += 4096) synthData[i] = i & 0xff;
const synth: ModelAsset = {
  name: "synthetic",
  bytes: SYNTH_BYTES,
  sha256: createHash("sha256").update(synthData).digest("hex"),
  source: { kind: "mirrored", url: "test://synthetic" },
  licence: "MIT",
  attribution: "check fixture",
};

class MemoryStore implements AssetStore {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  // A store that cannot be opened (private mode) throws on read, write and list alike.
  fault: string | null = null;
  async read(name: string) {
    if (this.fault !== null) throw new Error(this.fault);
    return this.files.get(name) ?? null;
  }
  async write(name: string, data: Uint8Array<ArrayBuffer>) {
    if (this.fault !== null) throw new Error(this.fault);
    this.files.set(name, data);
  }
  async list() {
    if (this.fault !== null) throw new Error(this.fault);
    return [...this.files].map(([name, data]) => ({ name, size: data.byteLength }));
  }
  async remove(name: string) {
    this.files.delete(name);
  }
}

// A body that arrives the way a network body does: in chunks, not as one buffer.
const CHUNK = 1024 * 1024;
const chunked = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += CHUNK) controller.enqueue(bytes.slice(at, Math.min(bytes.byteLength, at + CHUNK)));
      controller.close();
    },
  });

// A body that never ends on its own: it errors when the load aborts it, as a real
// transport does, and otherwise stays open — so a test that returns is one that aborted.
const openUntilAborted = (signal: AbortSignal): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
  });

// A part server over `bytes`, with an optional per-url override to simulate faults.
const serve = (bytes: Uint8Array, fault: (url: string, signal: AbortSignal) => Response | null = () => null) => {
  const calls: string[] = [];
  const plan = shardPlan(synth);
  const fetchLike = async (url: string, init: { readonly signal: AbortSignal }): Promise<Response> => {
    calls.push(url);
    const faulted = fault(url, init.signal);
    if (faulted !== null) return faulted;
    const shard = plan.find((s) => s.url === url);
    if (shard === undefined) return new Response(null, { status: 404 });
    return new Response(chunked(bytes.subarray(shard.start, shard.end)));
  };
  return { fetchLike, calls };
};

{
  const store = new MemoryStore();
  const { fetchLike, calls } = serve(synthData);
  const progress: number[] = [];
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, (p) => progress.push(p.loadedBytes));
  assert("network load succeeds", outcome.ok);
  if (outcome.ok) {
    assert("origin is network from an absent entry, persisted written", outcome.loaded.origin.kind === "network" && outcome.loaded.origin.miss.kind === "absent" && outcome.loaded.origin.persisted.kind === "written");
    assert("returned bytes equal the source", Buffer.compare(outcome.loaded.data, synthData) === 0);
  }
  assert("every part was fetched exactly once", calls.length === 3 && new Set(calls).size === 3);
  assert("progress is monotone and ends at the total", progress.every((v, i) => i === 0 || v >= progress[i - 1]!) && progress[progress.length - 1] === SYNTH_BYTES);
  const chunksServed = shardPlan(synth).reduce((n, s) => n + Math.ceil((s.end - s.start) / CHUNK), 0);
  assert("progress is reported once per received chunk, starting at 0", progress.length === 1 + chunksServed && progress[0] === 0);
  assert("store holds the bytes under the asset key", store.files.get(assetKey(synth))?.byteLength === SYNTH_BYTES);

  const again = serve(synthData);
  const secondProgress: number[] = [];
  const second = await loadAsset(synth, { fetch: again.fetchLike, store }, (p) => secondProgress.push(p.loadedBytes));
  assert("second load fetches zero parts", again.calls.length === 0);
  assert("second load comes from the store", second.ok && second.loaded.origin.kind === "store");
  assert("a store hit reports no progress: nothing was downloaded", secondProgress.length === 0);
}

{
  const store = new MemoryStore();
  const flipped = synthData.slice();
  flipped.fill(0xaa, SHARD_BYTES + 7, SHARD_BYTES + 8);
  const { fetchLike } = serve(flipped);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a flipped byte is an integrity failure", !outcome.ok && outcome.failure.kind === "integrity");
  assert("nothing is stored after an integrity failure", store.files.size === 0);
}

{
  const store = new MemoryStore();
  const plan = shardPlan(synth);
  const { fetchLike } = serve(synthData, (url) => (url === plan[1]!.url ? new Response(synthData.slice(plan[1]!.start, plan[1]!.end - 100)) : null));
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a truncated part is an integrity failure naming the short read", !outcome.ok && outcome.failure.kind === "integrity" && outcome.failure.actual.startsWith("short read"));
  assert("nothing is stored after a short read", store.files.size === 0);
}

{
  const store = new MemoryStore();
  const plan = shardPlan(synth);
  // Part 0 stays open until aborted; part 2 404s. The load can only return by aborting part 0.
  const { fetchLike } = serve(synthData, (url, signal) =>
    url === plan[0]!.url ? new Response(openUntilAborted(signal)) : url === plan[2]!.url ? new Response(null, { status: 404 }) : null,
  );
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a 404 part is an http failure naming the url", !outcome.ok && outcome.failure.kind === "http" && outcome.failure.status === 404 && outcome.failure.url === plan[2]!.url);
  assert("and the parts still in flight are aborted, the 404 reported as the cause", !outcome.ok && outcome.failure.kind === "http");
  assert("nothing is stored after an http failure", store.files.size === 0);
}

{
  const store = new MemoryStore();
  const plan = shardPlan(synth);
  const rejecting = async (url: string, init: { readonly signal: AbortSignal }) =>
    url === plan[1]!.url ? Promise.reject(new TypeError("Failed to fetch")) : serve(synthData).fetchLike(url, init);
  const outcome = await loadAsset(synth, { fetch: rejecting, store }, () => {});
  assert("a part whose fetch rejects is a network failure naming the url", !outcome.ok && outcome.failure.kind === "network" && outcome.failure.url === plan[1]!.url && outcome.failure.message === "Failed to fetch");
  assert("nothing is stored after a network failure", store.files.size === 0);
}

{
  const store = new MemoryStore();
  const plan = shardPlan(synth);
  const errorsMidStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(synthData.slice(plan[1]!.start, plan[1]!.start + CHUNK));
      controller.error(new Error("connection reset"));
    },
  });
  const { fetchLike } = serve(synthData, (url) => (url === plan[1]!.url ? new Response(errorsMidStream) : null));
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a body that errors mid-stream is a network failure naming the url", !outcome.ok && outcome.failure.kind === "network" && outcome.failure.url === plan[1]!.url && outcome.failure.message === "connection reset");
  assert("nothing is stored after a mid-stream error", store.files.size === 0);
}

{
  const store = new MemoryStore();
  store.fault = "QuotaExceededError";
  store.files.set(assetKey(synth), synthData.slice() as Uint8Array<ArrayBuffer>);
  const { fetchLike, calls } = serve(synthData);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  const origin = outcome.ok ? outcome.loaded.origin : null;
  assert("a store that cannot be read is an unreadable miss naming the fault: the bytes are downloaded", outcome.ok && origin?.kind === "network" && origin.miss.kind === "unreadable" && origin.miss.message === "QuotaExceededError" && calls.length === 3 && outcome.loaded.data.byteLength === SYNTH_BYTES);
  assert("and the store's fault is reported as persisted failed with the message", origin?.kind === "network" && origin.persisted.kind === "failed" && origin.persisted.message === "QuotaExceededError");
}

{
  const store = new MemoryStore();
  store.files.set(assetKey(synth), new Uint8Array(new ArrayBuffer(10)));
  const { fetchLike, calls } = serve(synthData);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  const origin = outcome.ok ? outcome.loaded.origin : null;
  assert("a wrong-sized store entry is a corrupt miss naming the size, re-downloaded", origin?.kind === "network" && origin.miss.kind === "corrupt" && origin.miss.actual === `10 of ${SYNTH_BYTES} bytes` && calls.length === 3);
  assert("and replaced in the store", store.files.get(assetKey(synth))?.byteLength === SYNTH_BYTES);
}

{
  const store = new MemoryStore();
  const wrong = synthData.slice();
  wrong.fill(0x55, SHARD_BYTES + 7, SHARD_BYTES + 8);
  store.files.set(assetKey(synth), wrong);
  const { fetchLike, calls } = serve(synthData);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  const origin = outcome.ok ? outcome.loaded.origin : null;
  assert("a right-sized store entry with the wrong bytes is a corrupt miss naming its hash, re-downloaded", origin?.kind === "network" && origin.miss.kind === "corrupt" && origin.miss.expected === synth.sha256 && origin.miss.actual === createHash("sha256").update(wrong).digest("hex") && calls.length === 3);
  assert("the bytes handed on are the network's, never the store's", outcome.ok && Buffer.compare(outcome.loaded.data, synthData) === 0);
  assert("and the store now holds the proven bytes", Buffer.compare(store.files.get(assetKey(synth))!, synthData) === 0 && origin?.kind === "network" && origin.persisted.kind === "written");
}

// ── 2b. residency ─────────────────────────────────────────────────────────────
console.log("residency:");
{
  const small: ModelAsset = { ...synth, name: "small", bytes: 4096, sha256: createHash("sha256").update(synthData.subarray(0, 4096)).digest("hex") };
  const both = [small, synth];
  const store = new MemoryStore();
  assert("an empty store: absent, every byte to download", JSON.stringify(await readResidency(store, both)) === JSON.stringify({ kind: "absent", bytesToDownload: 4096 + SYNTH_BYTES }));
  store.files.set(assetKey(synth), synthData.slice());
  assert("one asset short: absent, its bytes to download", JSON.stringify(await readResidency(store, both)) === JSON.stringify({ kind: "absent", bytesToDownload: 4096 }));
  store.files.set(assetKey(small), new Uint8Array(new ArrayBuffer(10)));
  assert("an entry at the wrong size counts as absent", JSON.stringify(await readResidency(store, both)) === JSON.stringify({ kind: "absent", bytesToDownload: 4096 }));
  store.files.set(assetKey(small), synthData.slice(0, 4096));
  assert("every asset listed at its size: resident", (await readResidency(store, both)).kind === "resident");
  store.files.set(`${MODEL_ASSET_PREFIX}weights-000000000000`, new Uint8Array(new ArrayBuffer(1)));
  assert("a stale key beside the live ones changes nothing", (await readResidency(store, both)).kind === "resident");
  assert("and prune removes only the stale key", JSON.stringify(await pruneStaleAssets(store, both)) === JSON.stringify({ kind: "pruned", removed: [`${MODEL_ASSET_PREFIX}weights-000000000000`] }) && (await readResidency(store, both)).kind === "resident");
  assert("the pure derivation is the same answer over the same listing", JSON.stringify(residencyOf(await store.list(), both)) === JSON.stringify({ kind: "resident" }));
  store.fault = "SecurityError: private browsing";
  assert("a store that cannot be listed: unavailable with its message", JSON.stringify(await readResidency(store, both)) === JSON.stringify({ kind: "unavailable", message: "SecurityError: private browsing", bytesToDownload: 4096 + SYNTH_BYTES }));

  assert("persist granted", (await askToKeep(async () => true)).kind === "granted");
  assert("persist denied", (await askToKeep(async () => false)).kind === "denied");
  assert("persist that throws: failed with the message", JSON.stringify(await askToKeep(async () => { throw new Error("no StorageManager"); })) === JSON.stringify({ kind: "failed", message: "no StorageManager" }));
}

{
  const store = new MemoryStore();
  const { fetchLike } = serve(synthData);
  const small: ModelAsset = { ...synth, name: "small", bytes: 4096, sha256: createHash("sha256").update(synthData.subarray(0, 4096)).digest("hex") };
  const plan = shardPlan(small);
  const fetchBoth = async (url: string, init: { readonly signal: AbortSignal }) => (url === plan[0]!.url ? new Response(synthData.slice(0, 4096)) : fetchLike(url, init));
  const progress: number[] = [];
  const outcome = await loadAssets([small, synth], { fetch: fetchBoth, store }, (p) => progress.push(p.loadedBytes));
  assert("loadAssets loads a set in order", outcome.ok && outcome.loaded.map((l) => l.asset.name).join(",") === "small,synthetic");
  assert("set progress is summed across assets, each count said once, and ends on the last byte", progress.every((v, i) => i === 0 || v > progress[i - 1]!) && progress[0] === 0 && progress[progress.length - 1] === 4096 + SYNTH_BYTES);
  const heldProgress: number[] = [];
  const held = await loadAssets([small, synth], { fetch: fetchBoth, store }, (p) => heldProgress.push(p.loadedBytes));
  assert("a set the store holds reports the last byte once and no partial: no bar flashes", held.ok && held.loaded.every((l) => l.origin.kind === "store") && heldProgress.join() === String(4096 + SYNTH_BYTES));

  store.files.set(`${MODEL_ASSET_PREFIX}weights-000000000000`, new Uint8Array(new ArrayBuffer(1)));
  store.files.set("unrelated", new Uint8Array(new ArrayBuffer(1)));
  const reloaded = await loadAssets([small, synth], { fetch: fetchBoth, store }, () => {});
  assert(
    "the set's load prunes first, and only stale entries under the prefix",
    reloaded.ok && JSON.stringify(reloaded.pruning) === JSON.stringify({ kind: "pruned", removed: [`${MODEL_ASSET_PREFIX}weights-000000000000`] }) && store.files.has("unrelated") && store.files.has(assetKey(synth)),
  );

  // slopspot-read-along-a35.azu: a browser blocking site data refuses the whole store, and
  // the page's word for it is "each listen downloads" — so the set's load must be a path
  // that ends in bytes, not in the store's refusal.
  store.fault = "Storage directory access is denied.";
  const refused = await loadAssets([small, synth], { fetch: fetchBoth, store }, () => {});
  const refusal = { kind: "failed", message: "Storage directory access is denied." };
  assert("a store that refuses everything: the set downloads and is handed on in memory", refused.ok && Buffer.compare(refused.loaded[1]!.data, synthData) === 0);
  assert(
    "and every refusal is a value on the outcome: the prune refused, each asset unreadable and not kept",
    refused.ok &&
      JSON.stringify(refused.pruning) === JSON.stringify({ kind: "refused", message: refusal.message }) &&
      refused.loaded.every((l) => JSON.stringify(l.origin) === JSON.stringify({ kind: "network", miss: { kind: "unreadable", message: refusal.message }, persisted: refusal })),
  );
  store.fault = null;
  const locked = Object.assign(new MemoryStore(), { remove: async () => { throw new Error("NoModificationAllowedError: the file is locked"); } });
  locked.files.set(`${MODEL_ASSET_PREFIX}weights-000000000000`, new Uint8Array(new ArrayBuffer(1)));
  const unpruned = await loadAssets([small, synth], { fetch: fetchBoth, store: locked }, () => {});
  assert("a store that lists but refuses a removal: the prune refused, the set still loads and is kept", unpruned.ok && unpruned.pruning.kind === "refused" && locked.files.has(assetKey(synth)));
}

// ── 3. mirror ─────────────────────────────────────────────────────────────────
console.log("mirror:");
{
  const dir = mkdtempSync(join(tmpdir(), "model-mirror-"));
  const repo = mkdtempSync(join(tmpdir(), "model-repo-"));
  const served: string[] = [];
  const serving = (bytes: Uint8Array) => async (url: string) => {
    served.push(url);
    return new Response(bytes.slice());
  };
  // The mirror takes a byte reader, so every case below is driven through the real one.
  const source = (bytes: Uint8Array) => readSource(repo, serving(bytes));
  const listed = () => readdirSync(join(dir, MODEL_ASSET_PREFIX)).sort().join(",");
  const expected = shardPlan(synth).map((s) => s.url.slice(MODEL_ASSET_PREFIX.length)).sort().join(",");

  assert("an empty directory is not a correct mirror", !mirrorIsCorrect(dir, synth));
  const first = await mirror(dir, source(synthData), synth);
  assert("a missing asset is fetched once and cut into its parts", first.action === "written" && served.length === 1 && listed() === expected);
  assert("the parts have their planned sizes", shardPlan(synth).every((s) => statSync(join(dir, s.url)).size === s.end - s.start));
  assert("a correct mirror is verified without a fetch", (await mirror(dir, source(synthData), synth)).action === "verified" && served.length === 1);

  writeFileSync(join(dir, shardPlan(synth)[1]!.url), synthData.subarray(0, 10));
  assert("a wrong-sized part makes the mirror incorrect", !mirrorIsCorrect(dir, synth));
  assert("and is refetched", (await mirror(dir, source(synthData), synth)).action === "written" && served.length === 2 && mirrorIsCorrect(dir, synth));

  const flipped = synthData.slice();
  flipped.fill(0xaa, SHARD_BYTES + 3, SHARD_BYTES + 4);
  writeFileSync(join(dir, shardPlan(synth)[1]!.url), flipped.subarray(SHARD_BYTES, 2 * SHARD_BYTES));
  assert("a right-sized part with wrong bytes makes the mirror incorrect", !mirrorIsCorrect(dir, synth));
  const mismatch = await mirror(dir, source(flipped), synth).catch((e: Error) => e.message);
  assert("a source whose bytes do not hash to the manifest aborts by asset name", typeof mismatch === "string" && mismatch.startsWith("synthetic: SHA-256 mismatch"));
  const short = await mirror(dir, source(synthData.subarray(0, 100)), synth).catch((e: Error) => e.message);
  assert("a source of the wrong size aborts by asset name", typeof short === "string" && short.startsWith("synthetic: expected"));
  assert("a failed refetch writes nothing: the incorrect part is still the old one", !mirrorIsCorrect(dir, synth));

  // The reader is where an origin's two arms are told apart, so its failures are asserted
  // on it rather than on the mirror that merely passes them on [LAW:single-enforcer].
  const url = synth.source.kind === "mirrored" ? synth.source.url : "";
  const read = (fetchSource: (url: string) => Promise<Response>) => readSource(repo, fetchSource)(synth).catch((e: Error) => e.message);
  assert("a source that cannot be fetched aborts by asset name", (await read(async () => { throw new TypeError("fetch failed"); })) === `synthetic: ${url} — fetch failed`);
  assert("a source whose body fails mid-read aborts by asset name", (await read(async () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) })))) === `synthetic: ${url} — terminated`);
  assert("a source that refuses aborts by asset name with the status", (await read(async () => new Response(null, { status: 403 }))) === `synthetic: ${url} — responded 403`);

  // An exported voice's bytes come off the disk, and never off the network: nothing about
  // its recording is a URL the build fetches.
  const exportedData = new Uint8Array([1, 2, 3, 4]);
  const exportedAsset: ModelAsset = {
    name: "voice-synthetic",
    bytes: exportedData.byteLength,
    sha256: createHash("sha256").update(exportedData).digest("hex"),
    source: { kind: "exported", recording: "test://recording.wav", upstream: "test://upstream.safetensors" },
    licence: "CC0-1.0",
    attribution: "check fixture",
  };
  const missing = await mirror(dir, source(exportedData), exportedAsset).catch((e: Error) => e.message);
  assert("an export the repo does not hold aborts by asset name, saying how to remake it", typeof missing === "string" && missing.startsWith(`voice-synthetic: ${exportedVoiceFile(exportedAsset)}`) && missing.includes("export-voice-prompts"));
  mkdirSync(join(repo, EXPORTED_VOICE_DIR), { recursive: true });
  writeFileSync(join(repo, exportedVoiceFile(exportedAsset)), exportedData);
  const fromRepo = await mirror(dir, source(exportedData), exportedAsset);
  assert("an export the repo holds is mirrored from it, with no fetch", fromRepo.action === "written" && served.length === 4 && mirrorIsCorrect(dir, exportedAsset));

  await mirror(dir, source(synthData), synth);
  writeFileSync(join(dir, `${MODEL_ASSET_PREFIX}weights-000000000000.part0`), new Uint8Array(3));
  const kept = [synth, exportedAsset]
    .flatMap((asset) => shardPlan(asset).map((s) => s.url.slice(MODEL_ASSET_PREFIX.length)))
    .sort()
    .join(",");
  const removed = pruneStaleParts(dir, [synth, exportedAsset]);
  // Both halves: what it says it removed, AND what is actually left. Without the second, an
  // implementation that reported one stale file while deleting the live ones would pass.
  assert("prune removes only parts no current plan names", removed.join() === `${MODEL_ASSET_PREFIX}weights-000000000000.part0` && listed() === kept);
  rmSync(dir, { recursive: true });
  rmSync(repo, { recursive: true });
}

// ── 4. published headers and the ignore rule ──────────────────────────────────
console.log("public/_headers:");
const ignored = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n");
assert("the mirror directory is gitignored under the asset prefix", ignored.includes(`public${MODEL_ASSET_PREFIX}`));
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const rule = headers.split(/\n(?=\S)/).find((block) => block.startsWith(`${MODEL_ASSET_PREFIX}*`)) ?? "";
assert("has a rule for the asset prefix", rule.length > 0);
assert("rule is immutable for a year", /Cache-Control:\s*public, max-age=31536000, immutable/.test(rule));
assert("rule allows cross-origin reads", /Access-Control-Allow-Origin:\s*\*/.test(rule));

if (process.exitCode === 1) console.error("\nmodel-assets-check: FAILED");
else console.log("\nmodel-assets-check: all passed");
