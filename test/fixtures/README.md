# Fixtures

Real captures of the inputs the parsers see in production. Treat them as
read-only evidence: hand-editing one breaks its claim to be what the source
actually produces.

## Capturing a claude.ai/share fixture

Never commit a raw scrape. Capture through the script — it performs the
production-identical Firecrawl scrape and scrubs credential-bearing content
(AWS pre-signed URL params; the leak class behind secret-scanning alert #1)
before anything touches disk:

```sh
npm run capture-fixture -- https://claude.ai/share/<uuid> claude-share-<name>
```

The script refuses to write if any scanner-matchable credential survives or
if scrubbing would change a line's parser-visible structure.

## The refetch-drift pair (`claude-share-refetch-old.md` / `claude-share-refetch-new.md`)

Two production-real scrapes of the SAME claude.ai/share conversation, captured
~6 weeks apart (2026-06-27 ingest vs 2026-08-09 recapture), with the upstream
conversation unchanged in between. Both passed the capture gates above (the old
bytes were re-run through the same scrub/leak/parse checks before committing).

What the pair proves — the design evidence for refetch freshness
(slopspot-freshness-eck):

- **Back-to-back fetches are byte-identical.** Two Firecrawl scrapes of this
  URL minutes apart produced identical bytes, so `fresh === stored` honestly
  means "nothing to update right now".
- **Byte drift does NOT imply upstream change.** Across weeks, the share page's
  own rendering changed — assistant citations now emit inline markdown links,
  and an extra date stamp renders — so the same conversation yields different
  bytes. A comparison can honestly claim "the live page differs from the stored
  snapshot", never "the conversation changed upstream".
- **Prompt alignment survives drift.** Parsed: 6 turns in both, user prompts
  byte-identical, 2/6 assistant turns differ. The diff substrate's
  prompt-keyed alignment therefore pairs turns correctly across render drift.

## The word-alignment capture (`word-alignment.json`)

The reference implementation's own record, for seven texts, of everything the
TypeScript port in `src/wordAlignment.ts` must reproduce. The reference is
dpm63/pocket-tts-timestamped, a fork of Kyutai's pocket-tts that reads word
timing off one attention head (layer 3, head 8). Captured with english_2026-04
and the alba voice; the top level is `{model, voice, captures}`.

Each capture is one text's full trace: `source` (the text asked for), `fed`
(what the fork actually fed the model), `units` (its text units over the fed
text), `tokens` and `pieces`, `tokenToUnit` (its fractional token-to-unit
matrix), `frames` (per generated frame: the unit scores from the attention
capture, whether the frame was voiced, its start time, the events the state
machine emitted), `finish` (the closing events), `words` (final word times),
and `samples`. `scripts/word-alignment-check.ts` consumes it without running a
model: given the reference's per-frame inputs, it proves the port builds the
same units and token map and emits the same events at the same times, so the
reference's measured accuracy is inherited by equality rather than re-measured.

Three things to know when comparing `source` to `fed`. The fork re-chunks text
with its own chunker, so for "foo.bar" it fed "foo. bar", and the check builds
the unit over the FED text. And when the source lacks terminal punctuation the
fork appends a "." marked `synthetic: true` on its last unit ("No terminal
punctuation here" became "No terminal punctuation here."); that is the speech
script's own rule too, so the check's utterance is the fed text minus that
synthetic punctuation. And every `begin`/`end` is a Python string index — a code
point — where the port's spans are UTF-16 units; the check converts at the
fixture's edge, and the seventh text carries an emoji so the conversion is
exercised.

The runtime this repo ships uses the english_2026-01 checkpoint; the fixture is
from english_2026-04. The head is the same for both, and the fixture proves the
port of the algorithm, not the weights. A separate teacher-forced comparison
against the fork on the english_2026-01 weights was run once during development
and is not a fixture.

Regenerate through `scripts/capture-word-alignment.py`, run inside a checkout
of the fork with its uv environment (about 13 s per text on CPU), where
`texts.json` is a JSON array of the source strings (the `source` fields of
the captures). Like the other fixtures, never hand-edit it.

```sh
cd <fork checkout> && uv run --no-dev python <this repo>/scripts/capture-word-alignment.py texts.json <this repo>/test/fixtures/word-alignment.json
```
