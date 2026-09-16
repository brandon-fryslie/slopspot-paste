// Renders every hosted voice's sample (src/voiceSample.ts) into public/voices/: the live
// preview's phrase (voiceChoice.previewText), spoken from the voice's own pinned embedding
// on the model release the site hosts — the bytes and the checkpoint the browser runs — and
// encoded as mono AAC. Each file is named by its hash, every other file under the prefix is
// removed, and the manifest entries to pin are printed: the bytes decide the name, and the
// manifest holds it [LAW:one-source-of-truth]. The render is seeded and pocket-tts pinned, so
// the same inputs are the same bytes: a changed hash means a changed voice, phrase or
// checkpoint. Run after any of those changes: `tsx scripts/render-voice-samples.ts`. Needs
// `uv` (which brings pocket-tts and torch) and `ffmpeg`; the embeddings are verified against
// the manifest, and fetched where they are missing or wrong.
//
// [LAW:effects-at-boundaries] The model runs in scripts/render-voice-sample.py, one voice per
// process; this script names, converts, hashes and files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, VOICE_IDS, shardPlan } from "../src/modelAssets";
import { previewText } from "../src/voiceChoice";
import { SAMPLE_PREFIX, sampleFile } from "../src/voiceSample";
import { mirror } from "./modelAssetMirror";

// The pocket-tts the samples are rendered with: the version the pinned bytes came from.
const POCKET_TTS = "pocket-tts==3.1.0";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const samplesDir = join(publicDir, SAMPLE_PREFIX);
const work = mkdtempSync(join(tmpdir(), "voice-samples-"));
mkdirSync(samplesDir, { recursive: true });

const pinned: string[] = [];
const written = new Set<string>();
for (const id of VOICE_IDS) {
  const asset = MODEL_ASSETS.voices[id];
  const [shard, ...rest] = shardPlan(asset);
  if (shard === undefined || rest.length !== 0) throw new Error(`render-voice-samples: ${id}'s embedding is not one part`);
  // The very bytes the manifest names, not whatever file sits at that name.
  await mirror(publicDir, fetch, asset);
  const embedding = join(publicDir, shard.url);
  const wav = join(work, `${id}.wav`);
  const m4a = join(work, `${id}.m4a`);
  console.log(`render-voice-samples: ${id} — rendering on ${MODEL_ASSETS.weights.release}…`);
  execFileSync("uv", ["run", "--with", POCKET_TTS, "--with", "scipy", "python", join(here, "render-voice-sample.py"), embedding, MODEL_ASSETS.weights.release, previewText(id).source, wav], { stdio: ["ignore", "ignore", "pipe"] });
  // Mono AAC at the model's rate: a few seconds is a few tens of kilobytes, and every stock
  // player and browser opens it. No metadata, so the same audio is the same bytes.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-map_metadata", "-1", "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", m4a], { stdio: ["ignore", "ignore", "pipe"] });
  const bytes = readFileSync(m4a);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = sampleFile(id, sha256);
  writeFileSync(join(samplesDir, name), bytes);
  written.add(name);
  console.log(`render-voice-samples: ${id} — ${name}, ${bytes.byteLength} bytes`);
  pinned.push(`  ${id}  { bytes: ${bytes.byteLength}, sha256: "${sha256}" }`);
}
// [LAW:carrying-cost] Nothing ships under the prefix but what was just rendered: a voice's
// old bytes, and the sample of a voice no longer hosted, would otherwise ride into every
// later deploy, and voice-sample-check.ts fails on a stray file.
for (const stale of readdirSync(samplesDir)) {
  if (written.has(stale)) continue;
  rmSync(join(samplesDir, stale));
  console.log(`render-voice-samples: removed stale ${stale}`);
}
rmSync(work, { recursive: true, force: true });
console.log(`render-voice-samples: pin these in src/modelAssets.ts, each as its voice's \`sample\` argument:\n${pinned.join("\n")}`);
