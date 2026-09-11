// Model-asset hosting check (slopspot-read-along-q35.cee). Three seams, driven with
// stubbed effects and no mocks of anything else [LAW:behavior-not-structure]:
//
//  1. src/modelAssets.ts — the manifest and its derivations. The shard plan must tile an
//     asset exactly under the static-asset file ceiling; addresses and MODEL_VERSION must
//     change when, and only when, the bytes do.
//  2. src/modelAssetLoader.ts — the browser edge. A network download reports byte-level
//     progress, verifies the hash, and persists; a second load fetches ZERO parts; a
//     wrong byte, a short read or an HTTP error is a typed failure with no bytes; a
//     store that cannot write is reported, not hidden; stale entries are pruned.
//  3. public/_headers — the published cache and CORS rule keyed on the same prefix.
//
// ─── loadAsset ACCEPT TABLE ──────────────────────────────────────────────────
//   store has key at the right size   -> ok, origin store, persisted hit, 0 fetches
//   store empty, parts correct         -> ok, origin network, persisted written, stored
//   store empty, a byte flipped        -> integrity failure, nothing stored
//   store empty, a part truncated      -> integrity failure (short read), nothing stored
//   a part 404s                        -> http failure naming the url, nothing stored
//   store.write throws                 -> ok with persisted failed{message}; bytes returned
//   store has key at the WRONG size    -> treated as absent: re-downloaded, origin network

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  MODEL_ASSETS,
  MODEL_ASSET_PREFIX,
  MODEL_VERSION,
  SHARD_BYTES,
  VOICE_IDS,
  allModelAssets,
  assetKey,
  downloadNeedsTap,
  modelVersion,
  shardPlan,
  type ModelAsset,
} from "../src/modelAssets";
import { loadAsset, loadAssets, pruneStaleAssets, type AssetStore } from "../src/modelAssetLoader";

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

for (const asset of assets) {
  const plan = shardPlan(asset);
  const tiles = plan.every((s, i) => s.start === (i === 0 ? 0 : plan[i - 1]!.end) && s.end > s.start && s.end - s.start <= SHARD_BYTES);
  assert(`${asset.name}: ${plan.length} part(s) tile [0, ${asset.bytes}) exactly`, tiles && plan[plan.length - 1]!.end === asset.bytes);
  assert(`${asset.name}: every part url is under ${MODEL_ASSET_PREFIX} and carries the sha prefix`, plan.every((s) => s.url.startsWith(assetKey(asset) + ".part") && assetKey(asset).includes(asset.sha256.slice(0, 12))));
}
assert("weights need more than one part; tokenizer needs exactly one", shardPlan(MODEL_ASSETS.weights).length > 1 && shardPlan(MODEL_ASSETS.tokenizer).length === 1);

const rehashed: ModelAsset = { ...MODEL_ASSETS.weights, sha256: "f".repeat(64) };
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
  source: "test://synthetic",
  licence: "MIT",
  attribution: "check fixture",
};

class MemoryStore implements AssetStore {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  writeError: string | null = null;
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async write(name: string, data: Uint8Array<ArrayBuffer>) {
    if (this.writeError !== null) throw new Error(this.writeError);
    this.files.set(name, data);
  }
  async list() {
    return [...this.files.keys()].map((name) => ({ name }));
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

// A part server over `bytes`, with an optional per-url override to simulate faults.
const serve = (bytes: Uint8Array, fault: (url: string) => Response | null = () => null) => {
  const calls: string[] = [];
  const plan = shardPlan(synth);
  const fetchLike = async (url: string): Promise<Response> => {
    calls.push(url);
    const faulted = fault(url);
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
    assert("origin is network, persisted written", outcome.loaded.origin === "network" && outcome.loaded.persisted.kind === "written");
    assert("returned bytes equal the source", Buffer.compare(outcome.loaded.data, synthData) === 0);
  }
  assert("every part was fetched exactly once", calls.length === 3 && new Set(calls).size === 3);
  assert("progress is monotone and ends at the total", progress.every((v, i) => i === 0 || v >= progress[i - 1]!) && progress[progress.length - 1] === SYNTH_BYTES);
  const chunksServed = shardPlan(synth).reduce((n, s) => n + Math.ceil((s.end - s.start) / CHUNK), 0);
  assert("progress is reported once per received chunk, starting at 0", progress.length === 1 + chunksServed && progress[0] === 0);
  assert("store holds the bytes under the asset key", store.files.get(assetKey(synth))?.byteLength === SYNTH_BYTES);

  const again = serve(synthData);
  const second = await loadAsset(synth, { fetch: again.fetchLike, store }, () => {});
  assert("second load fetches zero parts", again.calls.length === 0);
  assert("second load comes from the store", second.ok && second.loaded.origin === "store" && second.loaded.persisted.kind === "hit");
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
  const { fetchLike } = serve(synthData, (url) => (url === plan[2]!.url ? new Response(null, { status: 404 }) : null));
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a 404 part is an http failure naming the url", !outcome.ok && outcome.failure.kind === "http" && outcome.failure.status === 404 && outcome.failure.url === plan[2]!.url);
  assert("nothing is stored after an http failure", store.files.size === 0);
}

{
  const store = new MemoryStore();
  store.writeError = "QuotaExceededError";
  const { fetchLike } = serve(synthData);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a store that cannot write still returns the bytes", outcome.ok && outcome.loaded.data.byteLength === SYNTH_BYTES);
  assert("and reports persisted failed with the message", outcome.ok && outcome.loaded.persisted.kind === "failed" && outcome.loaded.persisted.message === "QuotaExceededError");
}

{
  const store = new MemoryStore();
  store.files.set(assetKey(synth), new Uint8Array(new ArrayBuffer(10)));
  const { fetchLike, calls } = serve(synthData);
  const outcome = await loadAsset(synth, { fetch: fetchLike, store }, () => {});
  assert("a wrong-sized store entry is re-downloaded", outcome.ok && outcome.loaded.origin === "network" && calls.length === 3);
  assert("and replaced in the store", store.files.get(assetKey(synth))?.byteLength === SYNTH_BYTES);
}

{
  const store = new MemoryStore();
  const { fetchLike } = serve(synthData);
  const small: ModelAsset = { ...synth, name: "small", bytes: 4096, sha256: createHash("sha256").update(synthData.subarray(0, 4096)).digest("hex") };
  const plan = shardPlan(small);
  const fetchBoth = async (url: string) => (url === plan[0]!.url ? new Response(synthData.slice(0, 4096)) : fetchLike(url));
  const progress: number[] = [];
  const outcome = await loadAssets([small, synth], { fetch: fetchBoth, store }, (p) => progress.push(p.loadedBytes));
  assert("loadAssets loads a set in order", outcome.ok && outcome.loaded.map((l) => l.asset.name).join(",") === "small,synthetic");
  assert("set progress is summed across assets and monotone", progress.every((v, i) => i === 0 || v >= progress[i - 1]!) && progress[progress.length - 1] === 4096 + SYNTH_BYTES);

  store.files.set(`${MODEL_ASSET_PREFIX}weights-000000000000`, new Uint8Array(new ArrayBuffer(1)));
  store.files.set("unrelated", new Uint8Array(new ArrayBuffer(1)));
  const removed = await pruneStaleAssets(store, [small, synth]);
  assert("prune removes only stale entries under the prefix", removed.join() === `${MODEL_ASSET_PREFIX}weights-000000000000` && store.files.has("unrelated") && store.files.has(assetKey(synth)));
}

// ── 3. published headers ──────────────────────────────────────────────────────
console.log("public/_headers:");
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const rule = headers.split(/\n(?=\S)/).find((block) => block.startsWith(`${MODEL_ASSET_PREFIX}*`)) ?? "";
assert("has a rule for the asset prefix", rule.length > 0);
assert("rule is immutable for a year", /Cache-Control:\s*public, max-age=31536000, immutable/.test(rule));
assert("rule allows cross-origin reads", /Access-Control-Allow-Origin:\s*\*/.test(rule));

if (process.exitCode === 1) console.error("\nmodel-assets-check: FAILED");
else console.log("\nmodel-assets-check: all passed");
