<!-- BEGIN LIT INTEGRATION -->
## lit Agent-Native Workflow

This repository uses `lit` for agent-native issue tracking.

Start by running `lit quickstart` to load the workflow instructions. It prints how tickets are found, created, updated, and closed here, so running it first means the rest of your work follows the conventions this repo expects. It's a quick, read-only command — no need to check in before running it.

<!-- END LIT INTEGRATION -->

## Governing architectural principle: store the original, derive the display

This program does exactly two things, in order: **(1) store the original submitted data
verbatim and losslessly, and (2) display that data in whatever format is required by deriving
the display from the stored original at render time.**

The original input is the **single source of truth**. The parsed turn list, the rendered HTML,
and every other view are **derived, disposable projections** of it — never the authority, never
the thing to preserve.

This is non-negotiable because the alternatives each carry a defect:
- Storing a display-shaped representation forces **migrations** to rewrite stale stored data
  whenever the display format changes.
- Transforming at write time forces a **lossy** choice between losing the original or persisting
  a representation that can never again tell the whole truth.

With the original kept intact, a display change is a renderer edit that re-derives every existing
paste for free — zero migration, zero loss.

In the laws' terms: `[LAW:one-source-of-truth]` (original is authoritative; parsed turns are a
cache), `[LAW:one-way-deps]` (display depends on storage, never the reverse),
`[LAW:no-silent-failure]` (the original is never silently discarded),
`[LAW:no-ambient-temporal-coupling]` (don't couple stored data to the renderer version that
wrote it). See `ARCHITECTURE.md` for the full statement.
