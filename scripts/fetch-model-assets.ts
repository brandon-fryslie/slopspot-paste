// Mirror the model assets into public/models/ before every build and dev (package.json
// pre-scripts). The logic lives in ./modelAssetMirror; this is the edge that names the
// directory and the fetch, and logs.
//
// public/models/ is gitignored: 240 MB of model is not source, and the manifest already
// records exactly which bytes belong there.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, allModelAssets } from "../src/modelAssets";
import { mirror, pruneStaleParts } from "./modelAssetMirror";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const assets = allModelAssets(MODEL_ASSETS);

for (const asset of assets) {
  const { action } = await mirror(publicDir, fetch, asset);
  console.log(`fetch-model-assets: ${asset.name} — ${action === "verified" ? "mirror verified, nothing to do" : `fetched ${asset.bytes} bytes from ${asset.source}, verified and mirrored`}`);
}
for (const url of pruneStaleParts(publicDir, assets)) console.log(`fetch-model-assets: removed stale ${url}`);
