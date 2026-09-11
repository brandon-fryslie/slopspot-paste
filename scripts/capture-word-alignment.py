# Captures, for each fixture text, everything the TS port must reproduce: the text units the
# fork builds, its token-to-unit map, the per-frame (unit scores, voiced, frame start) stream
# the state machine consumed, the events it emitted, and the final words.
import json, sys
import torch
from pocket_tts_timestamped import TTSModel, AudioChunk, WordStart, WordEnd
from pocket_tts_timestamped.timestamps import alignment as al

texts = json.load(open(sys.argv[1]))
model = TTSModel.load_model(language="english_2026-04")
voice = model.get_state_for_audio_prompt("alba")
tok = model.flow_lm.conditioner.tokenizer

out = []
for text in texts:
    frames = []
    orig_pf = al.WordAlignment.process_frame
    def pf(self, scores, voiced, frame_start):
        ev = orig_pf(self, scores, voiced, frame_start)
        frames.append({"scores": [float(s) for s in scores], "voiced": bool(voiced), "frameStart": float(frame_start),
                       "events": [ev_json(e) for e in ev]})
        return ev
    def ev_json(e):
        if isinstance(e, WordStart): return {"kind": "start", "word": e.word, "index": e.word_index, "t": e.start_time}
        return {"kind": "end", "word": e.word, "index": e.word_index, "start": e.start_time, "t": e.end_time}
    al.WordAlignment.process_frame = pf
    orig_fin = al.WordAlignment.finish
    finished = {}
    def fin(self, audio_end):
        ev = orig_fin(self, audio_end)
        finished["audioEnd"] = float(audio_end); finished["events"] = [ev_json(e) for e in ev]
        return ev
    al.WordAlignment.finish = fin
    # the chunk generation actually fed, recorded off the generator that consumes it
    fed = []
    orig_short = TTSModel._generate_audio_with_timestamps_short_text
    def short(self, **kw):
        fed.append(kw["timestamp_chunk"])
        return (yield from orig_short(self, **kw))
    TTSModel._generate_audio_with_timestamps_short_text = short
    res = model.generate_audio_with_timestamps(voice, text)
    TTSModel._generate_audio_with_timestamps_short_text = orig_short
    al.WordAlignment.process_frame = orig_pf
    al.WordAlignment.finish = orig_fin
    assert len(fed) == 1, [c.text for c in fed]
    tc = fed[0]
    out.append({
        "source": text,
        "fed": tc.text,
        "units": [{"text": u.text, "begin": u.chunk_begin, "end": u.chunk_end, "isWord": u.is_word, "synthetic": u.synthetic,
                   "wordIndex": (u.word.word_index if u.word else None), "sourceBegin": (u.word.begin if u.word else None), "sourceEnd": (u.word.end if u.word else None)} for u in tc.units],
        "tokens": [int(t) for t in tc.prepared_tokens[0]],
        "pieces": [tok.sp.id_to_piece(int(t)) for t in tc.prepared_tokens[0]],
        "tokenToUnit": tc.token_to_unit.tolist(),
        "frames": frames,
        "finish": finished,
        "words": [{"word": w.word, "index": w.word_index, "start": w.start_time, "end": w.end_time} for w in res.words],
        "samples": int(res.audio.shape[-1]),
    })
    print(text, "->", len(frames), "frames", len(res.words), "words", file=sys.stderr)
json.dump({"model": "english_2026-04", "voice": "alba", "captures": out}, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
