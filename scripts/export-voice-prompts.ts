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
// just produced, asked of the same `exportedVoiceFile` the build reads them back with — so an
// export whose bytes have changed lands at a name the manifest does not point at. That is
// SAID and fails the run, and the file the manifest still pins is left where it is, so a
// verification run can report drift without making the repo unbuildable.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORTED_VOICE_DIR, MODEL_ASSETS, SHA_PREFIX_CHARS, VOICE_IDS, exportedVoiceFile, shardPlan } from "../src/modelAssets";
import { mirror, readSource } from "./modelAssetMirror";
import { POCKET_TTS } from "./pocketTts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const publicDir = join(repoRoot, "public");
const exportsDir = join(repoRoot, EXPORTED_VOICE_DIR);
const work = mkdtempSync(join(tmpdir(), "voice-prompts-"));
// [LAW:no-silent-failure] leaves the failure alone and takes the scratch with it: a failed
// run would otherwise strand a 236 MB copy of the weights in $TMPDIR, once per attempt.
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
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
const drifted: string[] = [];
for (const { id, asset, origin } of exports) {
  console.log(`export-voice-prompts: ${id} — from ${origin.recording}…`);
  // pocket-tts reads the container by extension, so the copy keeps the recording's own.
  const recording = await fetchTo(origin.recording, join(work, `${id}${extname(new URL(origin.recording).pathname)}`));
  const upstream = await fetchTo(origin.upstream, join(work, `${id}-upstream.safetensors`));
  const out = join(work, `${id}.safetensors`);
  execFileSync("uv", ["run", "--with", POCKET_TTS, "--with", "pyyaml", "python", join(here, "export-voice-prompt.py"), weights.release, weightsFile, recording, upstream, out], { stdio: ["ignore", "inherit", "inherit"] });
  const bytes = readFileSync(out);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // [LAW:one-source-of-truth] The name the build will LOOK for, asked of the same function
  // that looks for it — not rebuilt to the same shape here, where it could drift into a
  // file every later build reports missing and this script cheerfully remakes wrong.
  const name = basename(exportedVoiceFile({ ...asset, sha256 }));
  made.set(name, bytes);
  console.log(`export-voice-prompts: ${id} — ${name}, ${bytes.byteLength} bytes`);
  pinned.push(`  ${id}  bytes: ${bytes.byteLength}, sha256: "${sha256}"`);
  if (sha256 !== asset.sha256) drifted.push(`  ${id}  manifest ${asset.sha256.slice(0, SHA_PREFIX_CHARS)} → exported ${sha256.slice(0, SHA_PREFIX_CHARS)}`);
}

// The new bytes land BEFORE anything is swept, so at no instant does the directory hold
// fewer voices than the manifest pins — a sweep that dies partway then costs a stale file,
// never a missing one, and a stale file is what the next run removes.
for (const [name, bytes] of made) writeFileSync(join(exportsDir, name), bytes);

// [LAW:carrying-cost] Nothing stays in the directory but what was just exported OR what the
// manifest currently pins: a voice's old bytes, and the export of a voice no longer hosted,
// would otherwise ride into every later deploy — and these are the only model bytes the repo
// carries, so nobody would see.
//
// WHY THE PINNED FILES ARE KEPT EVEN WHEN THIS RUN DID NOT MAKE THEM. The header invites
// running this to prove the checked-in bytes still match the recordings, and an export is
// verified to cosine 0.999, not to the bit — so a different torch, BLAS or device can produce
// a valid export with a different hash. Sweeping on that would delete the file the manifest
// names and break every build, with re-running this script (the remedy the build's own error
// suggests) regenerating the same wrong name forever. Keeping both leaves the repo buildable
// and the drift visible, and the next run sweeps the old file once the manifest is re-pinned.
// `recursive` because a stray directory here must go the same way rather than throwing EISDIR
// with half the sweep done.
const keep = new Set([...made.keys(), ...exports.map(({ asset }) => basename(exportedVoiceFile(asset)))]);
for (const stale of readdirSync(exportsDir)) {
  if (keep.has(stale)) continue;
  rmSync(join(exportsDir, stale), { recursive: true });
  console.log(`export-voice-prompts: removed stale ${stale}`);
}
console.log(`export-voice-prompts: pin these in src/modelAssets.ts:\n${pinned.join("\n")}`);

// [LAW:no-silent-failure] An export that does not hash to what the manifest pins is the whole
// point of a verification run, so it is said and it fails the run — never printed among the
// pins as though nothing had happened. Adding a voice lands here too, which is right: its
// entry does not yet name these bytes.
if (drifted.length > 0) {
  console.error(`export-voice-prompts: ${drifted.length} export(s) do not match the manifest's pins — re-pin them, or find out why the bytes moved:\n${drifted.join("\n")}`);
  process.exitCode = 1;
}
