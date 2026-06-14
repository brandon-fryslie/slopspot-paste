# Architecture

## The governing principle: store the original, derive the display

This program does exactly two things, in this order:

1. **Store the original data** — verbatim, lossless, exactly as the user submitted it.
2. **Display that data in whatever format is required** — by deriving the display from the stored original at read/render time.

The original submitted input is the **single source of truth**. Every rendered view — the
normalized turn list, the HTML, the minimap, any future hierarchical/progressive-disclosure
layout — is a **derived projection** of that original. Derived projections are disposable. They
are never the authority and must never be treated as the thing to preserve.

### Why this is the only correct design

The alternatives all require one or more of the following, and each is a defect:

- **Migrations to update stale stored data when the display format changes.** If you persist a
  display-shaped representation, then every change to how you display data forces you to walk and
  rewrite already-stored records. With the original kept intact, a display change is a one-line
  renderer edit that ships instantly and re-derives every existing paste for free — zero
  migration, nothing stored ever moves.

- **Lossy transformations at write time**, which force an impossible choice between *losing the
  original* or *storing a lossy representation*. Once information is dropped at ingestion, no
  amount of downstream cleverness can recover it; the representation can never tell the whole
  truth again because the truth was thrown away.

### In the language of the universal laws

- `[LAW:one-source-of-truth]` — The original input is the one authoritative representation. The
  parsed turns, the HTML, and every other view are derived and re-derivable. Caches are never
  authoritative; the parsed turn list is a cache of the original.
- `[LAW:no-silent-failure]` — A lossy write silently misrepresents an incomplete capture as a
  complete one. The original is never silently discarded.
- `[LAW:one-way-deps]` — Display depends on storage; storage never depends on display. The
  storage layer knows nothing about how anything is rendered.
- `[LAW:no-ambient-temporal-coupling]` — Persisting a display format couples stored data to the
  code version that wrote it, turning every format change into a schema-migration deployment
  event. Keeping the original decouples the two: the renderer is always free to change.

### What this means in practice

- **Capture is verbatim.** Every submit path stores the original bytes the user supplied (text
  arms store the raw content; the URL arm stores the originally fetched markdown; an edited import
  preserves the original input alongside the edited result). Nothing the user submitted is
  discarded.
- **Parsing/rendering is a pure function of the original**, computed at display time and freely
  re-derivable. If a parsed/normalized representation is stored, it is an explicitly-derived cache
  of the original, never the source of truth.
- **New display features change the derivation, not the stored schema.** Progressive disclosure,
  hierarchy, theming, and similar are properties of how we *render* the original — not new data
  to persist.
