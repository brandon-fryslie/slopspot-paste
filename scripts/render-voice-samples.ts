// Renders every hosted voice's sample (src/voiceSample.ts) into public/voices/: the live
// preview's phrase (voiceChoice.previewText), spoken from the voice's own pinned embedding
// on the model release the site hosts — the bytes and the checkpoint the browser runs — and
// encoded as mono AAC. Each file is named by its hash, a voice's stale files are removed, and
// the manifest entries to pin are printed: the bytes decide the name, and the manifest holds
// it [LAW:one-source-of-truth]. Run after a voice, the phrase or the checkpoint changes:
// `tsx scripts/render-voice-samples.ts`. Needs `uv` (which brings pocket-tts and torch),
// `ffmpeg`, and the embeddings mirrored by fetch-model-assets.ts.
//
// [LAW:effects-at-boundaries] The model runs in scripts/render-voice-sample.py, one voice per
// process; this script names, converts, hashes and files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, VOICE_IDS, shardPlan } from "../src/modelAssets";
import { previewText } from "../src/voiceChoice";
import { SAMPLE_PREFIX, sampleFile } from "../src/voiceSample";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const samplesDir = join(publicDir, SAMPLE_PREFIX);
const work = mkdtempSync(join(tmpdir(), "voice-samples-"));
mkdirSync(samplesDir, { recursive: true });

const pinned: string[] = [];
for (const id of VOICE_IDS) {
  const asset = MODEL_ASSETS.voices[id];
  const [shard, ...rest] = shardPlan(asset);
  if (shard === undefined || rest.length !== 0) throw new Error(`render-voice-samples: ${id}'s embedding is not one part`);
  const embedding = join(publicDir, shard.url);
  if (!existsSync(embedding)) throw new Error(`render-voice-samples: ${embedding} is not mirrored; run scripts/fetch-model-assets.ts first`);
  const wav = join(work, `${id}.wav`);
  const m4a = join(work, `${id}.m4a`);
  console.log(`render-voice-samples: ${id} — rendering on ${MODEL_ASSETS.weights.release}…`);
  execFileSync("uv", ["run", "--with", "pocket-tts", "--with", "scipy", "python", join(here, "render-voice-sample.py"), embedding, MODEL_ASSETS.weights.release, previewText(id).source, wav], { stdio: ["ignore", "ignore", "pipe"] });
  // Mono AAC at the model's rate: a few seconds is a few tens of kilobytes, and every stock
  // player and browser opens it. No metadata, so the same audio is the same bytes.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-map_metadata", "-1", "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", m4a], { stdio: ["ignore", "ignore", "pipe"] });
  const bytes = readFileSync(m4a);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = sampleFile(id, sha256);
  for (const stale of readdirSync(samplesDir)) {
    if (stale.startsWith(`${id}-`) && stale !== name) {
      rmSync(join(samplesDir, stale));
      console.log(`render-voice-samples: removed stale ${stale}`);
    }
  }
  writeFileSync(join(samplesDir, name), bytes);
  console.log(`render-voice-samples: ${id} — ${name}, ${bytes.byteLength} bytes`);
  pinned.push(`    ${id}: { bytes: ${bytes.byteLength}, sha256: "${sha256}" },`);
}
rmSync(work, { recursive: true, force: true });
console.log(`render-voice-samples: pin these in src/modelAssets.ts, each voice's \`sample\`:\n${pinned.join("\n")}`);
