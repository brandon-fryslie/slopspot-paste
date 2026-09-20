# One hosted voice's `audio_prompt`, exported from the recording it was made of — the same
# operation Kyutai's `export-voice` performs, run here because upstream stopped publishing
# its result. Driven by scripts/export-voice-prompts.ts; not run on its own.
#
# WHY THIS SCRIPT EXISTS. Kyutai published the first eight voices as the `audio_prompt` the
# browser speaks with (a [frames, 1024] conditioning tensor, ~0.5 MB). Every voice added to
# the catalogue since — the VCTK speakers and the LibriVox readers this site's later voices
# come from — is published ONLY as an already-prompted flow-model state: six layers of KV
# cache, 6-8 MB, twelve times the size, and a shape the runtime has no way to speak from
# (src/pocketTtsRuntime.ts concatenates a prompt with the text embeddings; it cannot be
# handed a primed cache). The recordings behind those states are published, so the prompt is
# recovered by encoding the recording rather than by inventing a second runtime path.
#
# WHY THE SITE'S OWN WEIGHTS, NOT `load_model(language=...)`. The build Kyutai serves under
# `pocket-tts-without-voice-cloning/languages/` has its Mimi encoder zeroed out — the repo's
# own `remove_voice_cloning_and_push.py` does it, and the file keeps its size, so the failure
# is silent: `_encode_audio` returns a tensor of zeros. The fp16 conversion this site hosts
# predates that removal and encodes correctly, and it is also the very build the browser
# runs, so the prompt exported here is the prompt that model would have made.
#
# WHY IT VERIFIES. Encoding the right recording on the right weights is the whole claim, and
# both halves are easy to get wrong silently (the zeroed encoder above; the raw recording
# where upstream used the noise-cleaned one). So the export is checked against the primed
# state Kyutai publishes for the same voice: prompt this export, and every cache tensor must
# match theirs. A mismatch exits non-zero rather than writing a voice nobody chose.
#
# Usage: python export-voice-prompt.py <release> <weights> <recording> <reference-state> <out>

import pathlib
import sys
import tempfile

import pocket_tts
import safetensors.torch
import torch
import yaml
from pocket_tts import TTSModel
from pocket_tts.models.tts_model import audio_read, convert_audio, init_states

# Cosine at fp16, measured: the site's fp16 weights reproduce Kyutai's fp32 primed state to
# about 1e-2 absolute on cache values of order 1, which is a cosine of 1.0 to six places. A
# voice built from the wrong recording lands at 0.6, and a zeroed encoder at 0.0 — there is
# no near miss between "the same voice" and "not it", so the bar sits well below the noise.
AGREEMENT = 0.999

release, weights, recording, reference, out = sys.argv[1:6]

# [LAW:one-source-of-truth] Kyutai's own config for this release, with one field replaced:
# where the weights are. Every other number describing the model — the codec's rate, the
# transformer's shape, whether a token precedes the voice — stays theirs, so a release that
# changes any of them is read correctly here without anyone remembering to copy it across.
packaged = pathlib.Path(pocket_tts.__file__).parent / "config" / f"{release}.yaml"
config = yaml.safe_load(packaged.read_text())
config["weights_path"] = str(pathlib.Path(weights).resolve())
# Only present to point at the encoder-less build; keeping it would let it be chosen.
config.pop("weights_path_without_voice_cloning", None)
# load_model wants a path, so the config is a file for exactly as long as that call — the
# directory takes itself away after, rather than leaving one temp file per voice per run.
with tempfile.TemporaryDirectory() as scratch:
    local = pathlib.Path(scratch) / f"{release}.yaml"
    local.write_text(yaml.safe_dump(config))
    model = TTSModel.load_model(config=str(local))
if model.flow_lm.insert_bos_before_voice:
    raise SystemExit(f"export-voice-prompt: {release} prepends a token before the voice; the browser does not")

audio, rate = audio_read(recording)
conditioning = convert_audio(audio, rate, model.config.mimi.sample_rate, 1)
with torch.no_grad():
    prompt = model._encode_audio(conditioning.unsqueeze(0).to(model.device))
    state = init_states(model.flow_lm, batch_size=1, sequence_length=prompt.shape[1])
    model._run_flow_lm_and_increment_step(model_state=state, audio_conditioning=prompt)

mine = {f"{module}/{key}": value for module, tensors in state.items() for key, value in tensors.items()}
theirs = safetensors.torch.load_file(reference)
missing = sorted(set(theirs) - set(mine))
if missing:
    raise SystemExit(f"export-voice-prompt: {reference} holds tensors this build has no state for: {', '.join(missing)}")
for name, want in sorted(theirs.items()):
    got = mine[name].cpu()
    if tuple(got.shape) != tuple(want.shape):
        raise SystemExit(f"export-voice-prompt: {name} is {tuple(got.shape)} here and {tuple(want.shape)} upstream — a different recording")
    # The offsets say how many frames were prompted; they are counts, and must be equal.
    if want.dtype == torch.int64:
        if not bool((got == want).all()):
            raise SystemExit(f"export-voice-prompt: {name} is {got.tolist()} here and {want.tolist()} upstream")
        continue
    cosine = float(torch.nn.functional.cosine_similarity(got.float().flatten(), want.float().flatten(), dim=0))
    if cosine < AGREEMENT:
        raise SystemExit(f"export-voice-prompt: {name} agrees with upstream to only {cosine:.6f} — this is not the voice upstream published")

# [LAW:one-source-of-truth] The one tensor the runtime reads, under the name it reads it by
# (src/pocketTtsRuntime.ts), and nothing else: an exported voice file and one of Kyutai's
# original eight are the same kind of file, indistinguishable to the loader.
safetensors.torch.save_file({"audio_prompt": prompt.cpu().contiguous()}, out)
print(f"export-voice-prompt: {out} — {tuple(prompt.shape)} frames, agrees with {reference}")
