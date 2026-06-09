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
