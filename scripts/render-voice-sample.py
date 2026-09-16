# One voice's sample: the phrase spoken from a pinned voice embedding — the very file the
# browser runs (src/modelAssets.ts) — on the model version the site hosts, prompted exactly as
# the runtime prompts it. Driven by scripts/render-voice-samples.ts; not run on its own.
#
# The pinned embedding holds the encoded audio prompt (`audio_prompt`, [1, frames, 1024]),
# which is what get_state_for_audio_prompt produces from a recording before it prompts the
# flow model with it; Pocket TTS's own `.safetensors` voices hold the prompted state instead,
# so this script does the prompting itself.
#
# The flow model samples noise at every frame, so the render is seeded: the same embedding,
# release and text are the same audio, and a changed hash in the manifest means a change in
# one of those, never the die.
#
# Usage: python render-voice-sample.py <embedding.safetensors> <language> <text> <out.wav>

import sys

import safetensors.torch
import scipy.io.wavfile
import torch
from pocket_tts import TTSModel
from pocket_tts.modules.stateful_module import init_states

embedding, language, text, out = sys.argv[1:5]
model = TTSModel.load_model(language=language)
torch.manual_seed(0)
with torch.no_grad():
    prompt = safetensors.torch.load_file(embedding)["audio_prompt"].to(model.device)
    if model.flow_lm.insert_bos_before_voice:
        prompt = torch.cat([model.flow_lm.bos_before_voice.detach(), prompt], dim=1)
    state = init_states(model.flow_lm, batch_size=1, sequence_length=prompt.shape[1])
    model._run_flow_lm_and_increment_step(model_state=state, audio_conditioning=prompt)
    # generate_audio deep-copies the state, which only leaf tensors allow.
    state = {module: {key: value.detach().clone() for key, value in tensors.items()} for module, tensors in state.items()}
    audio = model.generate_audio(state, text)
scipy.io.wavfile.write(out, model.sample_rate, audio.numpy())
