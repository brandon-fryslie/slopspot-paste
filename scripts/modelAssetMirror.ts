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
// [LAW:effects-at-boundaries] The directory and the byte reader are parameters, so the check
// drives this against a temp directory and a stub reader with no mocks of anything else.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_ASSET_PREFIX, exportedVoiceFile, shardPlan, type ModelAsset } from "../src/modelAssets";

export type SourceFetch = (url: string) => Promise<Response>;

// [LAW:types-are-the-program] How the build gets an asset's bytes: one function over the
// whole asset. `mirror` takes this rather than a fetch, so it never learns that an origin
// has kinds — it asks for bytes and verifies them, exactly as when every asset was a URL.
export type ReadSource = (asset: ModelAsset) => Promise<Uint8Array>;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// [LAW:single-enforcer] The ONE place AssetOrigin's two arms are told apart, and the only
// code in the build that knows an exported voice's bytes are checked in rather than
// fetched. `repoRoot` is the directory `exportedVoiceFile` paths are relative to.
//
// [LAW:no-silent-failure] Either arm failing is thrown, named by asset and by the place its
// bytes were looked for — a missing export says how to make it again rather than leaving a
// build to fail later on a hash nobody can explain.
export const readSource =
  (repoRoot: string, fetchSource: SourceFetch): ReadSource =>
  async (asset): Promise<Uint8Array> => {
    const origin = asset.source;
    switch (origin.kind) {
      case "mirrored":
        try {
          const response = await fetchSource(origin.url);
          if (!response.ok) throw new Error(`responded ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        } catch (e) {
          throw new Error(`${asset.name}: ${origin.url} — ${reason(e)}`);
        }
      case "exported":
        try {
          return readFileSync(join(repoRoot, exportedVoiceFile(asset)));
        } catch (e) {
          throw new Error(`${asset.name}: ${exportedVoiceFile(asset)} — ${reason(e)}; remake it with scripts/export-voice-prompts.ts`);
        }
    }
  };

const sha256 = (chunks: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return hash.digest("hex");
};

// The mirror is correct when every part exists at its planned size, hashes to the hash the
// manifest pins for THAT part, and the parts together hash to the manifest's hash for the
// whole. Sizes first because a stat is free and a hash of 236 MB is not.
//
// [LAW:one-source-of-truth] The two hashes are two claims about one set of bytes — a part's
// (what the browser proves a download against, modelAssetLoader.ts) and the whole's (what
// the asset is addressed by). They are checked together, here, at the only place that holds
// the bytes both describe, so a manifest whose part hashes drift from its own asset hash
// cannot reach a deploy: it fails the build instead of failing every reader's device.
export const mirrorIsCorrect = (publicDir: string, asset: ModelAsset): boolean => {
  const parts = shardPlan(asset).map((shard) => ({ path: join(publicDir, shard.url), size: shard.end - shard.start, sha256: shard.sha256 }));
  const sized = parts.every((part) => existsSync(part.path) && statSync(part.path).size === part.size);
  if (!sized) return false;
  const read = parts.map((part) => readFileSync(part.path));
  const pinned = parts.every((part, i) => sha256([read[i] as Uint8Array]) === part.sha256);
  return pinned && sha256(read) === asset.sha256;
};

export type MirrorResult = { readonly asset: ModelAsset; readonly action: "verified" | "written" };

export const mirror = async (publicDir: string, read: ReadSource, asset: ModelAsset): Promise<MirrorResult> => {
  if (mirrorIsCorrect(publicDir, asset)) return { asset, action: "verified" };
  const data = await read(asset);
  if (data.byteLength !== asset.bytes) {
    throw new Error(`${asset.name}: expected ${asset.bytes} bytes, received ${data.byteLength}`);
  }
  const actual = sha256([data]);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.name}: SHA-256 mismatch — manifest ${asset.sha256}, received ${actual}`);
  }
  // [LAW:no-silent-failure] The parts are cut here, so this is where the manifest's claim
  // about each one is proven. A mismatch is the manifest being wrong about bytes that are
  // right — nothing a reader could diagnose — so it aborts the build and says what the
  // manifest should have said.
  const plan = shardPlan(asset);
  const cut = plan.map((shard) => data.subarray(shard.start, shard.end));
  const wrong = plan.findIndex((shard, i) => sha256([cut[i] as Uint8Array]) !== shard.sha256);
  if (wrong !== -1) {
    throw new Error(
      `${asset.name}: the manifest pins part ${wrong} as ${plan[wrong]!.sha256}, but these bytes are ${sha256([cut[wrong] as Uint8Array])} — correct the parts list in src/modelAssets.ts`,
    );
  }
  for (const [i, shard] of plan.entries()) {
    const path = join(publicDir, shard.url);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, cut[i] as Uint8Array);
  }
  return { asset, action: "written" };
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
