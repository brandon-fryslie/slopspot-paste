// The editor's boundary. Everything DOM-, network-, and navigation-shaped lives
// here so the store and view stay pure. mount.ts instantiates the store with the
// real `EditorIo`, then drives lit-html rendering from mobx via `autorun`.
//
// [LAW:effects-at-boundaries] This is the one module that touches `fetch`,
// `window.location`, and `document`. The store orchestrates around the
// capabilities defined below; it never reaches the world itself.
//
// b48.5 wires index.astro to call mountEditor and adds the mount-point markup +
// CSS + no-JS fallback; this file only exposes the entry point.

import { autorun, comparer, reaction, type IReactionDisposer } from "mobx";
import { render } from "lit-html";
import { isOrigin, isTurns, upgradeOrigin } from "../types";
import { EditorStore, type Draft, type DraftLoadResult, type EditorIo, type ImportResult, type SubmitResult } from "./store";
import { appTemplate } from "./view";
import { enhanceClampBlocks } from "../clampBlocks";

// [LAW:no-defensive-null-guards] DOM lookup is a trust boundary — the page may
// not contain the element we expect. One loud guard here (with runtime
// `instanceof` verification, not a bare assertion) means the store/view get a
// typed non-null root and never re-defend. Mirrors the helper that lived in
// index.astro before the editor existed.
const must = <T,>(sel: string, ctor: new () => T): T => {
  const el = document.querySelector(sel);
  if (el === null) throw new Error(`required element missing: ${sel}`);
  if (!(el instanceof ctor)) throw new Error(`element ${sel} is not ${ctor.name}`);
  return el;
};

// [LAW:no-silent-failure] Both network calls validate their response shape at
// this boundary and surface a typed failure reason. /api/fetch and /api/paste
// are our own endpoints, but a non-200, a parse failure, or a malformed body
// becomes an explicit `{ ok: false }` the store renders — never a silent default.
const fetchShare = async (url: string): Promise<ImportResult> => {
  const res = await fetch("/api/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => null)) as
    | { turns?: unknown; origin?: unknown; error?: unknown }
    | null;
  if (!res.ok || data === null) {
    return { ok: false, reason: errorText(data, "Failed to fetch the URL.") };
  }
  // [LAW:no-silent-failure] The captured origin is part of the response contract;
  // junk in it is a malformed response, not a value to quietly degrade to null.
  if (!isTurns(data.turns) || !isOrigin(data.origin)) {
    return { ok: false, reason: "Malformed response from /api/fetch." };
  }
  return { ok: true, turns: data.turns, origin: data.origin };
};

// [LAW:no-silent-failure] The agent-handoff restore. /api/draft is our own
// endpoint, but a 404 (expired/unknown id), a non-200, or a malformed body
// becomes an explicit { ok: false } the store renders as an import error — never
// a silent fall-through to an empty editor.
const fetchDraft = async (id: string): Promise<DraftLoadResult> => {
  const res = await fetch("/api/draft?id=" + encodeURIComponent(id));
  const data = (await res.json().catch(() => null)) as
    | { turns?: unknown; origin?: unknown; error?: unknown }
    | null;
  if (!res.ok || data === null || !isTurns(data.turns)) {
    return { ok: false, reason: errorText(data, "This draft has expired or was not found.") };
  }
  // [LAW:single-enforcer] Lift any legacy origin the same way the KV read and the
  // localStorage loader do; a null/junk origin reads as no-provenance, not failure.
  const upgraded = upgradeOrigin(data.origin);
  return { ok: true, draft: { turns: data.turns, origin: isOrigin(upgraded) ? upgraded : null } };
};

const submit = async (draft: Draft): Promise<SubmitResult> => {
  const res = await fetch("/api/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turns: draft.turns, origin: draft.origin, platformOverride: draft.platformOverride }),
  });
  const data = (await res.json().catch(() => null)) as
    | { slug?: unknown; error?: unknown }
    | null;
  if (!res.ok || typeof data?.slug !== "string") {
    return { ok: false, reason: errorText(data, "Server error.") };
  }
  return { ok: true, slug: data.slug };
};

const errorText = (data: { error?: unknown } | null, fallback: string): string =>
  typeof data?.error === "string" ? data.error : fallback;

// [LAW:effects-at-boundaries] localStorage draft persistence — the editor's only
// durable client-side world. The store never touches it; it persists/restores
// through these capabilities.
//
// [LAW:single-enforcer] loadDraft is the one gate between stored JSON and the
// store: it validates with isTurns/isOrigin, so a corrupt or stale-schema
// draft becomes "no draft" (the empty Draft) rather than a malformed value
// poisoning the editor. Drafts saved before the origin shape landed are a bare
// Turn[] (or carried a `source` string) — lifted to a Draft with null origin on
// read, the same idempotent migration shape the KV layer uses.
//
// [LAW:no-silent-failure] exception: storage can be denied entirely (private
// mode, quota, disabled). That failure has no downstream consumer — the
// authoritative submit path through /api/paste is independent — so persistence
// degrades to "no draft" instead of breaking editing. A swallow is justified
// only because nothing reads the result; it never masks a failure in the real
// save path.
const DRAFT_KEY = "slopspot:editor-draft";

const EMPTY_DRAFT: Draft = { turns: [], origin: null };

const saveDraft = (draft: Draft): void => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable — persistence degrades, editing is unaffected */
  }
};

const loadDraft = (): Draft => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as unknown;
    if (isTurns(parsed)) return { turns: parsed, origin: null };
    const o = parsed as { turns?: unknown; origin?: unknown } | null;
    if (o && isTurns(o.turns)) {
      // [LAW:single-enforcer] Run the SAME legacy-origin migration the server applies
      // on KV read (types.upgradeOrigin), so a draft saved before the URL arm was
      // generalized — its origin still the legacy { kind:"claude-share", … } shape —
      // hydrates as a replayable url origin instead of failing isOrigin and silently
      // dropping its provenance to null. [LAW:no-silent-failure]
      const upgraded = upgradeOrigin(o.origin);
      return { turns: o.turns, origin: isOrigin(upgraded) ? upgraded : null };
    }
    return EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
};

const clearDraft = (): void => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable — nothing persisted, nothing to clear */
  }
};

// [LAW:one-source-of-truth][LAW:no-ambient-temporal-coupling] The single owner of
// WHEN the draft is persisted: a mobx reaction off the derived Draft. It fires
// whenever the blocks or provenance change shape (structural compare — a fresh
// toTurns array with identical content is not a write), so persistence is
// data-driven rather than sprinkled across every mutation. Exported so the store
// test wires the exact same persistence path that ships, not a hand-rolled copy.
export const persistDrafts = (store: EditorStore, io: EditorIo): IReactionDisposer =>
  reaction(
    // [LAW:one-source-of-truth] Persist the IMPORT origin (where the turns came
    // from), not the stamp-time submitOrigin — so a restored draft re-establishes
    // the same editable state, and isDirty is judged against the same baseline.
    (): Draft => ({ turns: store.turns, origin: store.importOrigin }),
    (draft) => io.saveDraft(draft),
    { equals: comparer.structural },
  );

export const mountEditor = (rootSelector = "#editor-root"): EditorStore => {
  const root = must(rootSelector, HTMLElement);
  const io: EditorIo = {
    fetchShare,
    fetchDraft,
    submit,
    navigate: (slug) => window.location.assign("/" + slug),
    saveDraft,
    loadDraft,
    clearDraft,
  };
  const store = new EditorStore(io);
  // [LAW:no-ambient-temporal-coupling] Draft source is decided once, here, at the
  // boundary that can read the URL. A ?draft=<id> handoff (an agent staged this
  // content via /api/draft) takes precedence over the localStorage draft — the
  // agent just placed it for review, so a stale local draft must not shadow it.
  // With no ?draft, restore the localStorage draft as before (absent/corrupt loads
  // as [], the same empty editor a fresh visit gets). The server load is async:
  // render starts empty and the autorun re-renders when the draft resolves (or
  // when its failure lands in importError). Both run before persist is wired so
  // restoring doesn't immediately re-save an identical draft.
  const draftId = new URLSearchParams(window.location.search).get("draft");
  if (draftId === null || draftId === "") {
    store.restoreDraft(io.loadDraft());
  } else {
    void store.loadServerDraft(draftId);
  }
  // [LAW:no-ambient-temporal-coupling] mobx's autorun is the single render
  // owner: it runs once now and again whenever any observable the template reads
  // changes. Render order is not folklore — it's whatever the reactive graph
  // dictates, with one explicit scheduler.
  // [LAW:single-enforcer] The preview shows the SAME clamp affordance the
  // permalink does: after each render, enhance any freshly-rendered spine prose.
  // enhanceClampBlocks is idempotent (it marks what it measured), so re-running
  // on every autorun only touches newly-rendered nodes; when the Blocks view is
  // shown there are no `.clampable` elements and it returns before any reflow.
  autorun(() => {
    render(appTemplate(store), root);
    enhanceClampBlocks(root);
  });
  persistDrafts(store, io);
  return store;
};
