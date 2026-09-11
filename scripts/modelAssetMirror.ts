// The deploy-time mirror: make a directory hold exactly the parts src/modelAssets.ts names,
// so `astro build` publishes them as static assets. Idempotent — a correct mirror costs one
// hash pass and no network.
//
// [LAW:one-source-of-truth] Nothing here decides a path, a size, or a cut: every part file
// is written at the URL shardPlan() gives, with the bytes it names, and the whole is proven
// against the manifest's SHA-256 before a single part is written. The mirror is a derived
// projection of the manifest; the manifest is the authority, and a file the manifest does
// not name is removed.
//
// [LAW:no-silent-failure] A source that cannot be fetched, a size that differs, or a hash
// that does not match aborts the build, named by asset. Publishing unverified weights would
// ship a model nobody measured.
//
// [LAW:effects-at-boundaries] The directory and the fetch are parameters, so the check drives
// this against a temp directory and a stub fetch with no mocks of anything else.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_ASSET_PREFIX, shardPlan, type ModelAsset } from "../src/modelAssets";

export type SourceFetch = (url: string) => Promise<Response>;

const sha256 = (chunks: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return hash.digest("hex");
};

// The mirror is correct when every part exists at its planned size and the parts hash to
// the manifest's SHA-256. Sizes first because a stat is free and a hash of 236 MB is not.
export const mirrorIsCorrect = (publicDir: string, asset: ModelAsset): boolean => {
  const paths = shardPlan(asset).map((s) => ({ path: join(publicDir, s.url), size: s.end - s.start }));
  const sized = paths.every((p) => existsSync(p.path) && statSync(p.path).size === p.size);
  return sized && sha256(paths.map((p) => readFileSync(p.path))) === asset.sha256;
};

export type MirrorResult = { readonly asset: ModelAsset; readonly action: "verified" | "fetched" };

export const mirror = async (publicDir: string, fetchSource: SourceFetch, asset: ModelAsset): Promise<MirrorResult> => {
  if (mirrorIsCorrect(publicDir, asset)) return { asset, action: "verified" };
  let data: Uint8Array;
  try {
    const response = await fetchSource(asset.source);
    if (!response.ok) throw new Error(`responded ${response.status}`);
    data = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    throw new Error(`${asset.name}: ${asset.source} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (data.byteLength !== asset.bytes) {
    throw new Error(`${asset.name}: expected ${asset.bytes} bytes, received ${data.byteLength}`);
  }
  const actual = sha256([data]);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.name}: SHA-256 mismatch — manifest ${asset.sha256}, received ${actual}`);
  }
  for (const shard of shardPlan(asset)) {
    const path = join(publicDir, shard.url);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data.subarray(shard.start, shard.end));
  }
  return { asset, action: "fetched" };
};

// [LAW:carrying-cost] A new model build is a new file name; the old parts would otherwise
// ride into every later deploy. Remove every file under the prefix that no current plan
// names. Returns the urls removed so the caller can log them.
export const pruneStaleParts = (publicDir: string, keep: readonly ModelAsset[]): readonly string[] => {
  const dir = join(publicDir, MODEL_ASSET_PREFIX);
  if (!existsSync(dir)) return [];
  const live = new Set(keep.flatMap((asset) => shardPlan(asset).map((s) => s.url)));
  const stale = readdirSync(dir)
    .map((file) => `${MODEL_ASSET_PREFIX}${file}`)
    .filter((url) => !live.has(url));
  for (const url of stale) unlinkSync(join(publicDir, url));
  return stale;
};
