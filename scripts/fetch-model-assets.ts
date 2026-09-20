// Mirror the model assets into public/models/ before every build and dev (package.json
// pre-scripts). The logic lives in ./modelAssetMirror; this is the edge that names the
// directory and the fetch, and logs.
//
// public/models/ is gitignored: 240 MB of model is not source, and the manifest already
// records exactly which bytes belong there.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, allModelAssets, exportedVoiceFile } from "../src/modelAssets";
import { mirror, pruneStaleParts, readSource } from "./modelAssetMirror";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const assets = allModelAssets(MODEL_ASSETS);
const read = readSource(repoRoot, fetch);

for (const asset of assets) {
  const { action } = await mirror(publicDir, read, asset);
  const from = asset.source.kind === "mirrored" ? asset.source.url : exportedVoiceFile(asset);
  console.log(`fetch-model-assets: ${asset.name} — ${action === "verified" ? "mirror verified, nothing to do" : `took ${asset.bytes} bytes from ${from}, verified and mirrored`}`);
}
for (const url of pruneStaleParts(publicDir, assets)) console.log(`fetch-model-assets: removed stale ${url}`);
