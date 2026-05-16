# slopspot · paste

Share LLM conversations as a readable chat UI. Anonymous, write-once, auto-deletes after 30 days.

Live at **https://paste.slopspot.ai**.

## Architecture

- **Astro 6** SSR deployed as a **Cloudflare Worker** (free tier). The Astro 6 Cloudflare adapter is Workers-first — Pages is no longer the deploy target.
- **Cloudflare KV** for storage, with `expirationTtl: 30 days` per write — the storage layer is the **single enforcer** of expiry. No cleanup job exists or needs to exist.
- **marked** for markdown rendering at the edge. Code blocks render as plain monospace with a language label; syntax highlighting is a planned follow-up (Shiki was prototyped but failed in the workerd dev sandbox).
- Slug is a 10-char random base57 string from `crypto.getRandomValues`; it is the only identity.

## One-time setup

```bash
# 1. Install
cd slopspot-paste
npm install

# 2. Auth wrangler (one-time, opens browser)
wrangler login

# 3. Create both KV namespaces and copy IDs into wrangler.toml
wrangler kv namespace create PASTES
wrangler kv namespace create PASTES --preview
wrangler kv namespace create SESSION   # required by the adapter even if unused
# Paste the printed ids into the [[kv_namespaces]] blocks in wrangler.toml.

# 4. Set the custom-domain claim in wrangler.toml (already done for paste.slopspot.ai):
#   [[routes]]
#   pattern = "paste.slopspot.ai"
#   custom_domain = true
```

> ⚠️  Do **not** also create a manual DNS record for the hostname.
> `custom_domain = true` tells Cloudflare the Worker owns the DNS record — it
> will refuse to claim a hostname that already has a manually-managed record.

## Dev

```bash
npm run dev          # local Astro dev (in-memory KV emulation)
npm run preview      # built worker via wrangler dev (real KV bindings)
```

## Deploy

```bash
npm run deploy
```

This runs `astro build && wrangler deploy --config dist/server/wrangler.json`.
The adapter generates a full Workers config at `dist/server/wrangler.json`
(including `main`, `[assets]`, and merged bindings) — wrangler reads from there.

After the first deploy, two URLs serve the Worker:

- `https://slopspot-paste.<account>.workers.dev` — permanent fallback.
- `https://paste.slopspot.ai` — primary, via `custom_domain` route.

## Recognized paste formats

The parser converges these inputs into the same `Turn[]`:

- Markdown headings: `## User` / `## Assistant` / `## System`
- ChatGPT copy-paste: `You said:` / `ChatGPT said:` markers
- Claude copy-paste: `Human:` / `Assistant:` markers
- Bare name + colon on its own line: `User:` / `Assistant:`

If none match, the entire paste renders as a single assistant turn.

## Why this shape

The types are the program. A `Conversation` is `{ slug, createdAt, expiresAt, turns: Turn[], title }`. There is no `ownerId`, no `editedAt`, no `deletedAt`, no edit token — every one of those fields would admit an illegal state under the anonymous + write-once + 30-day rules. Expiry lives in KV's `expirationTtl`; the app never checks "is this expired" because the record cannot exist past its TTL.
