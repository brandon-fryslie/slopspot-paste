// The deploy-time mirror: make public/models/ hold exactly the parts src/modelAssets.ts
// names, so `astro build` publishes them as static assets. Runs before every build and
// dev (package.json pre-scripts); idempotent — a correct mirror costs one hash pass and
// no network.
//
// [LAW:one-source-of-truth] Nothing here decides a path, a size, or a cut: every part file
// is written at the URL shardPlan() gives, with the bytes it names, and the whole is proven
// against the manifest's SHA-256 before a single part is written. The mirror is a derived
// projection of the manifest; the manifest is the authority.
//
// [LAW:no-silent-failure] A source that cannot be fetched, a size that differs, or a hash
// that does not match aborts the build by name. Publishing unverified weights would ship a
// model nobody measured.
//
// public/models/ is gitignored: 240 MB of model is not source, and the manifest already
// records exactly which bytes belong there.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, allModelAssets, shardPlan, type ModelAsset } from "../src/modelAssets";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const sha256 = (chunks: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return hash.digest("hex");
};

const partPath = (url: string): string => join(publicDir, url);

// The mirror is correct when every part exists at its planned size and the parts hash to
// the manifest's SHA-256. Sizes first because a stat is free and a hash of 236 MB is not.
const mirrorIsCorrect = (asset: ModelAsset): boolean => {
  const plan = shardPlan(asset);
  const sized = plan.every((s) => existsSync(partPath(s.url)) && statSync(partPath(s.url)).size === s.end - s.start);
  return sized && sha256(plan.map((s) => readFileSync(partPath(s.url)))) === asset.sha256;
};

const mirror = async (asset: ModelAsset): Promise<void> => {
  if (mirrorIsCorrect(asset)) {
    console.log(`fetch-model-assets: ${asset.name} — mirror verified, nothing to do`);
    return;
  }
  console.log(`fetch-model-assets: ${asset.name} — fetching ${asset.bytes} bytes from ${asset.source}`);
  const response = await fetch(asset.source);
  if (!response.ok) throw new Error(`${asset.name}: ${asset.source} responded ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength !== asset.bytes) {
    throw new Error(`${asset.name}: expected ${asset.bytes} bytes, received ${data.byteLength}`);
  }
  const actual = sha256([data]);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.name}: SHA-256 mismatch — manifest ${asset.sha256}, received ${actual}`);
  }
  for (const shard of shardPlan(asset)) {
    mkdirSync(dirname(partPath(shard.url)), { recursive: true });
    writeFileSync(partPath(shard.url), data.subarray(shard.start, shard.end));
  }
  console.log(`fetch-model-assets: ${asset.name} — verified and mirrored as ${shardPlan(asset).length} part(s)`);
};

for (const asset of allModelAssets(MODEL_ASSETS)) await mirror(asset);
