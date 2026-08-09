---
name: verify
description: Run and drive slopspot-paste locally to verify a change end-to-end — launch recipe, the URL-ingest egress gotcha, and the flows worth driving.
---

# Verifying slopspot-paste

## Launch

- `npm run dev` → http://localhost:4321 — fine for **everything except URL ingest**.
- **Gotcha:** outbound fetch from the worker (`/api/fetch` → Firecrawl) fails in
  BOTH `astro dev` and local `wrangler dev` on this machine ("Uncaught Error:
  internal error" in workerd; surfaces as "Firecrawl request failed (network
  error)"). It is the local simulator, not the code — the same build works on
  the edge.
- To verify URL ingest for real, run the worker remotely. `.dev.vars` is
  gitignored, so create it first from the agent-memory secrets
  (`FIRECRAWL_API_KEY` from the firecrawl-key memory powers the fetch arm;
  `DEEPSEEK_API_TOKEN` from the macOS keychain powers summaries):

  ```bash
  printf 'FIRECRAWL_API_KEY=%s\nDEEPSEEK_API_TOKEN=%s\n' "<firecrawl key>" "<deepseek token>" > .dev.vars
  npm run build
  cp .dev.vars dist/server/.dev.vars
  cd dist/server && CLOUDFLARE_API_TOKEN=<token from memory> \
    npx wrangler dev --remote --config wrangler.json --port 8788
  ```

  → http://localhost:8788 executes on Cloudflare's edge with real egress and
  real secrets. `/api/fetch` is read-only (no KV writes), so this is safe;
  don't drive `/api/paste` submits against it casually — that writes prod KV.

## Drive

Use Chrome DevTools MCP. The editor is client-rendered; simulate typing/pasting
with `pane.value = ...; pane.dispatchEvent(new Event("input", { bubbles: true }))`
on `textarea.source-text`. Firecrawl round-trips take 5–25s and sometimes time
out at 20s — a timeout is a real failure state worth observing (retry via the
"Try again" button), poll up to ~35s before judging.

Flows worth driving: paste transcript → blocks derive live; paste URL →
auto-fetch (status in `.import-row .fetch-status`) → lands in Preview; edit a
block then re-derive/fetch → `.reparse-confirm` strip stages; claude.ai/code
link → `.code-link-notice`, never fetched; secret paste → `.secret-warnings`.
