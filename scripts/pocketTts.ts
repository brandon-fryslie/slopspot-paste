// [LAW:one-source-of-truth] The pocket-tts release every build-time script runs the model
// through. The voice prompts (export-voice-prompts.ts) and the samples
// (render-voice-samples.ts) must be made on the SAME build, or a voice's sample would
// quietly stand for audio its prompt no longer produces — so the pin is one fact, here,
// rather than a literal in each script.
export const POCKET_TTS = "pocket-tts==3.1.0";
