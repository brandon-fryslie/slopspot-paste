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
//   store has key at the right size   -> ok, origin store, persisted hit, 0 fetches
//   store empty, parts correct         -> ok, origin network, persisted written, stored
//   store empty, a byte flipped        -> integrity failure, nothing stored
//   store empty, a part truncated      -> integrity failure (short read), nothing stored
//   a part 404s                        -> http failure naming the url, nothing stored,
//                                         the other parts aborted
//   a part's fetch rejects             -> network failure naming the url, nothing stored
//   a part's body errors mid-stream    -> network failure naming the url, nothing stored
//   store.write throws                 -> ok with persisted failed{message}; bytes returned
//   store.read throws                  -> a miss: downloaded, persisted failed{message}
//   store has key at the WRONG size    -> treated as absent: re-downloaded, origin network

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { mirror, mirrorIsCorrect, pruneStaleParts } from "./modelAssetMirror";

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
  // A store that cannot be opened (private mode) throws on read and write alike.
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
  assert("a store that cannot be read is a miss: the bytes are downloaded", outcome.ok && outcome.loaded.origin === "network" && calls.length === 3 && outcome.loaded.data.byteLength === SYNTH_BYTES);
  assert("and the store's fault is reported as persisted failed with the message", outcome.ok && outcome.loaded.persisted.kind === "failed" && outcome.loaded.persisted.message === "QuotaExceededError");
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
  const fetchBoth = async (url: string, init: { readonly signal: AbortSignal }) => (url === plan[0]!.url ? new Response(synthData.slice(0, 4096)) : fetchLike(url, init));
  const progress: number[] = [];
  const outcome = await loadAssets([small, synth], { fetch: fetchBoth, store }, (p) => progress.push(p.loadedBytes));
  assert("loadAssets loads a set in order", outcome.ok && outcome.loaded.map((l) => l.asset.name).join(",") === "small,synthetic");
  assert("set progress is summed across assets and monotone", progress.every((v, i) => i === 0 || v >= progress[i - 1]!) && progress[progress.length - 1] === 4096 + SYNTH_BYTES);

  store.files.set(`${MODEL_ASSET_PREFIX}weights-000000000000`, new Uint8Array(new ArrayBuffer(1)));
  store.files.set("unrelated", new Uint8Array(new ArrayBuffer(1)));
  const removed = await pruneStaleAssets(store, [small, synth]);
  assert("prune removes only stale entries under the prefix", removed.join() === `${MODEL_ASSET_PREFIX}weights-000000000000` && store.files.has("unrelated") && store.files.has(assetKey(synth)));
}

// ── 3. mirror ─────────────────────────────────────────────────────────────────
console.log("mirror:");
{
  const dir = mkdtempSync(join(tmpdir(), "model-mirror-"));
  const served: string[] = [];
  const source = (bytes: Uint8Array) => async (url: string) => {
    served.push(url);
    return new Response(bytes.slice());
  };
  const listed = () => readdirSync(join(dir, MODEL_ASSET_PREFIX)).sort().join(",");
  const expected = shardPlan(synth).map((s) => s.url.slice(MODEL_ASSET_PREFIX.length)).sort().join(",");

  assert("an empty directory is not a correct mirror", !mirrorIsCorrect(dir, synth));
  const first = await mirror(dir, source(synthData), synth);
  assert("a missing asset is fetched once and cut into its parts", first.action === "fetched" && served.length === 1 && listed() === expected);
  assert("the parts have their planned sizes", shardPlan(synth).every((s) => statSync(join(dir, s.url)).size === s.end - s.start));
  assert("a correct mirror is verified without a fetch", (await mirror(dir, source(synthData), synth)).action === "verified" && served.length === 1);

  writeFileSync(join(dir, shardPlan(synth)[1]!.url), synthData.subarray(0, 10));
  assert("a wrong-sized part makes the mirror incorrect", !mirrorIsCorrect(dir, synth));
  assert("and is refetched", (await mirror(dir, source(synthData), synth)).action === "fetched" && served.length === 2 && mirrorIsCorrect(dir, synth));

  const flipped = synthData.slice();
  flipped.fill(0xaa, SHARD_BYTES + 3, SHARD_BYTES + 4);
  writeFileSync(join(dir, shardPlan(synth)[1]!.url), flipped.subarray(SHARD_BYTES, 2 * SHARD_BYTES));
  assert("a right-sized part with wrong bytes makes the mirror incorrect", !mirrorIsCorrect(dir, synth));
  const mismatch = await mirror(dir, source(flipped), synth).catch((e: Error) => e.message);
  assert("a source whose bytes do not hash to the manifest aborts by asset name", typeof mismatch === "string" && mismatch.startsWith("synthetic: SHA-256 mismatch"));
  const refused = await mirror(dir, async () => { throw new TypeError("fetch failed"); }, synth).catch((e: Error) => e.message);
  assert("a source that cannot be fetched aborts by asset name", refused === `synthetic: ${synth.source} — fetch failed`);
  const cut = await mirror(dir, async () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) })), synth).catch((e: Error) => e.message);
  assert("a source whose body fails mid-read aborts by asset name", cut === `synthetic: ${synth.source} — terminated`);
  const denied = await mirror(dir, async () => new Response(null, { status: 403 }), synth).catch((e: Error) => e.message);
  assert("a source that refuses aborts by asset name with the status", denied === `synthetic: ${synth.source} — responded 403`);
  const short = await mirror(dir, source(synthData.subarray(0, 100)), synth).catch((e: Error) => e.message);
  assert("a source of the wrong size aborts by asset name", typeof short === "string" && short.startsWith("synthetic: expected"));
  assert("a failed refetch writes nothing: the incorrect part is still the old one", !mirrorIsCorrect(dir, synth));

  await mirror(dir, source(synthData), synth);
  writeFileSync(join(dir, `${MODEL_ASSET_PREFIX}weights-000000000000.part0`), new Uint8Array(3));
  const removed = pruneStaleParts(dir, [synth]);
  assert("prune removes only parts no current plan names", removed.join() === `${MODEL_ASSET_PREFIX}weights-000000000000.part0` && listed() === expected);
  rmSync(dir, { recursive: true });
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
