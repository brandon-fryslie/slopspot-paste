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
import type { ParseResult } from "../types";
import { isSourceKind, isTurns } from "../types";
import { EditorStore, type Draft, type EditorIo, type SubmitResult } from "./store";
import { appTemplate } from "./view";

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
const fetchShare = async (url: string): Promise<ParseResult> => {
  const res = await fetch("/api/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => null)) as
    | { turns?: unknown; source?: unknown; error?: unknown }
    | null;
  if (!res.ok || data === null) {
    return { ok: false, reason: errorText(data, "Failed to fetch the URL.") };
  }
  // [LAW:no-silent-failure] source is part of the response contract; junk in it
  // is a malformed response, not a value to quietly degrade to null.
  if (!isTurns(data.turns) || !isSourceKind(data.source)) {
    return { ok: false, reason: "Malformed response from /api/fetch." };
  }
  return { ok: true, turns: data.turns, source: data.source };
};

const submit = async (draft: Draft): Promise<SubmitResult> => {
  const res = await fetch("/api/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turns: draft.turns, sourceKind: draft.source }),
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
// store: it validates with isTurns/isSourceKind, so a corrupt or stale-schema
// draft becomes "no draft" (the empty Draft) rather than a malformed value
// poisoning the editor. Drafts saved before provenance landed are a bare
// Turn[] — lifted to a Draft with null source on read, same idempotent
// migration shape the KV layer uses.
//
// [LAW:no-silent-failure] exception: storage can be denied entirely (private
// mode, quota, disabled). That failure has no downstream consumer — the
// authoritative submit path through /api/paste is independent — so persistence
// degrades to "no draft" instead of breaking editing. A swallow is justified
// only because nothing reads the result; it never masks a failure in the real
// save path.
const DRAFT_KEY = "slopspot:editor-draft";

const EMPTY_DRAFT: Draft = { turns: [], source: null };

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
    if (isTurns(parsed)) return { turns: parsed, source: null };
    const o = parsed as { turns?: unknown; source?: unknown } | null;
    if (o && isTurns(o.turns)) {
      return { turns: o.turns, source: isSourceKind(o.source) ? o.source : null };
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
    (): Draft => ({ turns: store.turns, source: store.source }),
    (draft) => io.saveDraft(draft),
    { equals: comparer.structural },
  );

export const mountEditor = (rootSelector = "#editor-root"): EditorStore => {
  const root = must(rootSelector, HTMLElement);
  const io: EditorIo = {
    fetchShare,
    submit,
    navigate: (slug) => window.location.assign("/" + slug),
    saveDraft,
    loadDraft,
    clearDraft,
  };
  const store = new EditorStore(io);
  // Restore any persisted draft before the first render. An absent/corrupt draft
  // loads as [] — the same empty editor a fresh visit gets — so this is one
  // unconditional load, never an "is there a draft" branch. Done before persist
  // is wired so restoring doesn't immediately re-save an identical draft.
  store.restoreDraft(io.loadDraft());
  // [LAW:no-ambient-temporal-coupling] mobx's autorun is the single render
  // owner: it runs once now and again whenever any observable the template reads
  // changes. Render order is not folklore — it's whatever the reactive graph
  // dictates, with one explicit scheduler.
  autorun(() => render(appTemplate(store), root));
  persistDrafts(store, io);
  return store;
};
