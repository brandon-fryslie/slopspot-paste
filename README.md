# slopspot · paste

Share LLM conversations as readable chat UI. Anonymous, write-once, auto-deletes after 30 days.

Lives at **paste.slopspot.ai**.

## Architecture

- **Astro 6** SSR on **Cloudflare Pages** (free tier).
- **Cloudflare KV** for storage, with `expirationTtl: 30 days` per write — the storage layer is the single enforcer of expiry. No cleanup job exists or needs to exist.
- **marked** for markdown rendering at the edge. Code blocks render as plain monospace with a language label; syntax highlighting is a planned follow-up.
- Slug is a 10-char random base57 string; it is the only identity.

## One-time setup

```bash
# 1. Install
cd slopspot-paste
npm install

# 2. Create the KV namespace and copy the IDs into wrangler.toml
wrangler kv namespace create PASTES
wrangler kv namespace create PASTES --preview

# Paste the printed `id` and `preview_id` values into wrangler.toml.

# 3. Auth wrangler (one-time, opens browser)
wrangler login

# 4. Create the Pages project (one-time)
wrangler pages project create slopspot-paste --production-branch main
```

## Dev

```bash
npm run dev          # local dev with in-memory KV via Astro
npm run preview      # build, then run wrangler pages dev against ./dist
```

`wrangler pages dev` honors the KV binding in `wrangler.toml`, so `--preview` is closest to production.

## Deploy

```bash
npm run deploy
```

Pushes to the `production` Pages env. First deploy gives you `slopspot-paste.pages.dev`.

## DNS — `paste.slopspot.ai`

In Cloudflare DNS for `slopspot.ai`:

| Type  | Name  | Target                        | Proxy |
| ----- | ----- | ----------------------------- | ----- |
| CNAME | paste | `slopspot-paste.pages.dev`    | ✓     |

Then in the Pages project → Custom domains → Add `paste.slopspot.ai`. Cloudflare provisions the cert automatically.

## Recognized paste formats

The parser converges these inputs to the same `Turn[]` shape:

- Markdown headings: `## User` / `## Assistant` / `## System`
- ChatGPT copy-paste: `You said:` / `ChatGPT said:` markers
- Claude copy-paste: `Human:` / `Assistant:` markers
- Bare name + colon on its own line: `User:` / `Assistant:`

If none match, the entire paste renders as a single assistant turn.

## Why this shape

The types are the program. A `Conversation` is `{ slug, createdAt, expiresAt, turns: Turn[], title }`. There is no `ownerId`, no `editedAt`, no `deletedAt`, no edit token — every one of those fields would admit an illegal state under the anonymous + write-once + 30-day rules. Expiry lives in KV's `expirationTtl`; the app never checks "is this expired" because the record cannot exist past its TTL.
