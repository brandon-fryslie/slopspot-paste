// Remakes every `exported` voice's prompt from the recording the manifest names, into
// assets/voices/. Run after adding an exported voice, or to prove the checked-in bytes are
// still what the recordings say: `tsx scripts/export-voice-prompts.ts`. Needs `uv` (which
// brings pocket-tts and torch); the weights come from the mirror, so a first run downloads
// the model like any build does.
//
// WHY A VOICE IS EXPORTED AT ALL is on `AssetOrigin` in src/modelAssets.ts, and the model
// work is scripts/export-voice-prompt.py — one voice per process, which also verifies the
// export against the primed state Kyutai publishes. This script names, fetches, files and
// prints [LAW:effects-at-boundaries].
//
// [LAW:one-source-of-truth] Nothing here names a voice, a recording or an upstream state:
// the manifest does, and this walks it. The output file is named from the hash of the bytes
// just produced, which is also how `exportedVoiceFile` addresses them — so an export whose
// bytes have changed lands at a name the manifest does not point at, and the next build
// says so rather than publishing bytes nobody pinned.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORTED_VOICE_DIR, MODEL_ASSETS, SHA_PREFIX_CHARS, VOICE_IDS, shardPlan } from "../src/modelAssets";
import { mirror, readSource } from "./modelAssetMirror";
import { POCKET_TTS } from "./pocketTts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const publicDir = join(repoRoot, "public");
const exportsDir = join(repoRoot, EXPORTED_VOICE_DIR);
const work = mkdtempSync(join(tmpdir(), "voice-prompts-"));
mkdirSync(exportsDir, { recursive: true });

const fetchTo = async (url: string, path: string): Promise<string> => {
  const response = await fetch(url);
  // [LAW:no-silent-failure] A recording that 404s is a manifest that has gone stale against
  // upstream, which is exactly the thing worth hearing about loudly.
  if (!response.ok) throw new Error(`export-voice-prompts: ${url} responded ${response.status}`);
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  return path;
};

// The weights the prompt is encoded with are the ones the site hosts, as one file: the
// mirror holds them in parts, and pocket-tts wants a path.
const { weights } = MODEL_ASSETS;
await mirror(publicDir, readSource(repoRoot, fetch), weights);
const weightsFile = join(work, "weights.safetensors");
writeFileSync(weightsFile, Buffer.concat(shardPlan(weights).map((shard) => readFileSync(join(publicDir, shard.url)))));

// [LAW:dataflow-not-control-flow] Which voices are exported is decided once, as a list;
// the loop below then runs the same steps for every row it is given.
const exports = VOICE_IDS.flatMap((id) => {
  const asset = MODEL_ASSETS.voices[id];
  // The id, not the asset name, so a printed pin can be pasted beside the key it belongs to.
  return asset.source.kind === "exported" ? [{ id, asset, origin: asset.source }] : [];
});

// Every voice is exported before any is filed, so a run that fails partway leaves the
// directory as it was rather than half-remade.
const made = new Map<string, Uint8Array>();
const pinned: string[] = [];
for (const { id, asset, origin } of exports) {
  console.log(`export-voice-prompts: ${id} — from ${origin.recording}…`);
  // pocket-tts reads the container by extension, so the copy keeps the recording's own.
  const recording = await fetchTo(origin.recording, join(work, `${id}${extname(new URL(origin.recording).pathname)}`));
  const upstream = await fetchTo(origin.upstream, join(work, `${id}-upstream.safetensors`));
  const out = join(work, `${id}.safetensors`);
  execFileSync("uv", ["run", "--with", POCKET_TTS, "--with", "pyyaml", "python", join(here, "export-voice-prompt.py"), weights.release, weightsFile, recording, upstream, out], { stdio: ["ignore", "inherit", "inherit"] });
  const bytes = readFileSync(out);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${asset.name}-${sha256.slice(0, SHA_PREFIX_CHARS)}.safetensors`;
  made.set(name, bytes);
  console.log(`export-voice-prompts: ${id} — ${name}, ${bytes.byteLength} bytes`);
  pinned.push(`  ${id}  bytes: ${bytes.byteLength}, sha256: "${sha256}"`);
}

// [LAW:carrying-cost] Nothing stays in the directory but what was just exported: a voice's
// old bytes, and the export of a voice no longer hosted, would otherwise ride into every
// later deploy — and these are the only model bytes the repo carries, so nobody would see.
for (const stale of readdirSync(exportsDir)) {
  if (made.has(stale)) continue;
  rmSync(join(exportsDir, stale));
  console.log(`export-voice-prompts: removed stale ${stale}`);
}
for (const [name, bytes] of made) writeFileSync(join(exportsDir, name), bytes);
rmSync(work, { recursive: true, force: true });
console.log(`export-voice-prompts: pin these in src/modelAssets.ts:\n${pinned.join("\n")}`);
