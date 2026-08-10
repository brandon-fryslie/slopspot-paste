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
