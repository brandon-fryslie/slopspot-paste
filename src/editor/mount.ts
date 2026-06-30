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
import { isOrigin, isPlatform, isTurns, upgradeOrigin } from "../types";
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

// [LAW:effects-at-boundaries] The EFFECT half of an HTTP-JSON call: perform the
// request and read the body, and nothing else — no domain judgement. fetch()
// REJECTS on a dropped connection (offline, DNS, abort); that one transport failure
// is caught and reported as a distinct `transport-error` outcome, so this never
// throws (the capabilities below honor their `Promise<...Result>` type and the
// store interior stays pure). It returns the raw status and the parsed body (or
// null when the body isn't JSON); deciding what each status/body MEANS is the pure
// decoder's job, not the effect's.
export type HttpOutcome =
  | { readonly kind: "response"; readonly status: number; readonly body: Record<string, unknown> | null }
  | { readonly kind: "transport-error" };

const httpJson = async (input: string, init?: RequestInit): Promise<HttpOutcome> => {
  try {
    const res = await fetch(input, init);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { kind: "response", status: res.status, body };
  } catch {
    return { kind: "transport-error" };
  }
};

const errorText = (data: { error?: unknown } | null, fallback: string): string =>
  typeof data?.error === "string" ? data.error : fallback;

// [LAW:no-silent-failure][LAW:effects-at-boundaries] The PURE half: classify an
// HttpOutcome into the failure modes that MUST be told apart, each with its own
// reason — a transport error (never reached the server), a non-2xx response
// (surface the server's own error text when present, else a generic server reason;
// e.g. a real 404 keeps "expired or was not found" sourced once from the endpoint,
// while a 5xx is NOT mislabeled as expired), or a 2xx whose body wasn't a JSON
// object (malformed). A clean 2xx object body flows on to the caller's own shape
// decode. No fetch here, so it is unit-testable in isolation [LAW:verifiable-goals].
type Decoded =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface DecodeReasons {
  readonly transport: string;
  readonly server: string;
  readonly malformed: string;
}

export const decodeJson = (outcome: HttpOutcome, reasons: DecodeReasons): Decoded => {
  if (outcome.kind === "transport-error") return { ok: false, reason: reasons.transport };
  if (outcome.status < 200 || outcome.status >= 300) {
    return { ok: false, reason: errorText(outcome.body, reasons.server) };
  }
  if (outcome.body === null) return { ok: false, reason: reasons.malformed };
  return { ok: true, data: outcome.body };
};

const POST_JSON = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// [LAW:no-silent-failure] Each call is the EFFECT (httpJson) composed with the pure
// classifier (decodeJson) and then its own shape decode. /api/fetch and /api/paste
// are our own endpoints, but a transport failure, a non-2xx, a parse failure, or a
// malformed body becomes an explicit `{ ok: false }` the store renders — each with
// its own honest reason, never a single catch-all and never an escaped rejection.
const fetchShare = async (url: string): Promise<ImportResult> => {
  const decoded = decodeJson(await httpJson("/api/fetch", POST_JSON({ url })), {
    transport: "Couldn't reach the server.",
    server: "Failed to fetch the URL.",
    malformed: "Malformed response from /api/fetch.",
  });
  if (!decoded.ok) return decoded;
  // [LAW:no-silent-failure] The captured origin is part of the response contract;
  // junk in it is a malformed response, not a value to quietly degrade to null.
  if (!isTurns(decoded.data.turns) || !isOrigin(decoded.data.origin)) {
    return { ok: false, reason: "Malformed response from /api/fetch." };
  }
  return { ok: true, turns: decoded.data.turns, origin: decoded.data.origin };
};

// [LAW:no-silent-failure] The agent-handoff restore. A transport failure, a 404
// (expired/unknown id — its message sourced once from the endpoint), any other
// non-2xx, or a malformed body each becomes an explicit { ok: false } with its own
// reason the store renders as an import error — never a silent fall-through to an
// empty editor, never a stuck-busy editor from an escaped rejection, and never a
// 5xx/transport failure mislabeled as "expired".
// Exported so the view-check exercises the SHIPPING boundary (httpJson + decodeJson
// + this validation), proving a transport rejection becomes a typed {ok:false}
// rather than an escaped rejection. [LAW:verifiable-goals]
export const fetchDraft = async (id: string): Promise<DraftLoadResult> => {
  const decoded = decodeJson(await httpJson("/api/draft?id=" + encodeURIComponent(id)), {
    // [LAW:one-source-of-truth] The 404 "expired or was not found" text is sourced
    // once from the endpoint body (draft.ts GET) via errorText; this `server`
    // fallback is the GENERIC non-2xx reason, so a 5xx is never mislabeled "expired".
    transport: "Couldn't reach the server to load the draft.",
    server: "Couldn't load the draft (server error).",
    malformed: "Malformed response from /api/draft.",
  });
  if (!decoded.ok) return decoded;
  if (!isTurns(decoded.data.turns)) {
    return { ok: false, reason: "Malformed response from /api/draft." };
  }
  // [LAW:single-enforcer] Lift any legacy origin the same way the KV read and the
  // localStorage loader do; a null/junk origin reads as no-provenance, not failure.
  const upgraded = upgradeOrigin(decoded.data.origin);
  // [LAW:one-source-of-truth] Carry the saved theme override through restore (the
  // same isPlatform gate the KV read and the paste decode use); dropping it here
  // would reopen with the wrong theme and republish a different override than was
  // saved. Junk reads as "no override" (auto-derive), not failure.
  const platformOverride = isPlatform(decoded.data.platformOverride) ? decoded.data.platformOverride : undefined;
  return {
    ok: true,
    draft: { turns: decoded.data.turns, origin: isOrigin(upgraded) ? upgraded : null, platformOverride },
  };
};

const submit = async (draft: Draft): Promise<SubmitResult> => {
  const decoded = decodeJson(
    await httpJson("/api/paste", POST_JSON({ turns: draft.turns, origin: draft.origin, platformOverride: draft.platformOverride })),
    { transport: "Couldn't reach the server.", server: "Server error.", malformed: "Server error." },
  );
  if (!decoded.ok) return decoded;
  if (typeof decoded.data.slug !== "string") return { ok: false, reason: "Server error." };
  return { ok: true, slug: decoded.data.slug };
};

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
    const o = parsed as { turns?: unknown; origin?: unknown; platformOverride?: unknown } | null;
    if (o && isTurns(o.turns)) {
      // [LAW:single-enforcer] Run the SAME legacy-origin migration the server applies
      // on KV read (types.upgradeOrigin), so a draft saved before the URL arm was
      // generalized — its origin still the legacy { kind:"claude-share", … } shape —
      // hydrates as a replayable url origin instead of failing isOrigin and silently
      // dropping its provenance to null. [LAW:no-silent-failure]
      const upgraded = upgradeOrigin(o.origin);
      // [LAW:one-source-of-truth] Same isPlatform gate as the KV read — restore the
      // saved theme pick; junk or a pre-override draft reads as "no override".
      const platformOverride = isPlatform(o.platformOverride) ? o.platformOverride : undefined;
      return { turns: o.turns, origin: isOrigin(upgraded) ? upgraded : null, platformOverride };
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

// [LAW:effects-at-boundaries] The server-side counterpart of clearDraft: revoke the
// KV handoff draft this editor was opened from. Fire-and-forget by design — null is
// "no server draft to revoke" (from-scratch / localStorage restore), so it no-ops
// with no request, exactly as clearDraft no-ops when nothing is persisted.
//
// [LAW:no-silent-failure] exception: the DELETE's outcome has no downstream consumer.
// The draft's DRAFT_TTL_SECONDS expiry is the AUTHORITATIVE revocation backstop, so a
// failed immediate delete degrades to TTL expiry — the exact behavior that shipped
// before this endpoint existed — not a masked failure in a load-bearing path. The
// swallow is justified by the same reasoning saveDraft/clearDraft swallow localStorage.
const deleteDraft = (id: string | null): void => {
  if (id === null || id === "") return;
  void httpJson("/api/draft?id=" + encodeURIComponent(id), { method: "DELETE" });
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
    // platformOverride rides along so a reload re-establishes the user's theme pick
    // too; without it the same drop the server-draft path had survives on reload.
    (): Draft => ({
      turns: store.turns,
      origin: store.importOrigin,
      platformOverride: store.userPlatform ?? undefined,
    }),
    (draft) => io.saveDraft(draft),
    { equals: comparer.structural },
  );

// [LAW:effects-at-boundaries] History manipulation is a world effect; the store
// never touches the address bar. Removes the consumed ?draft handoff param while
// preserving the path, any other query params, and the hash.
const stripDraftParam = (): void => {
  const url = new URL(window.location.href);
  url.searchParams.delete("draft");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
};

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
    deleteDraft,
  };
  const store = new EditorStore(io);
  // [LAW:no-ambient-temporal-coupling] Draft source is decided once, here, at the
  // boundary that can read the URL. A ?draft=<id> handoff (an agent staged this
  // content via /api/draft) takes precedence over the localStorage draft — the
  // agent just placed it for review, so a stale local draft must not shadow it.
  // With no ?draft, restore the localStorage draft synchronously (absent/corrupt
  // loads as [], the same empty editor a fresh visit gets) — before persist is
  // wired, so restoring doesn't immediately re-save an identical draft. The server
  // load is async: render starts empty and the autorun re-renders when the draft
  // resolves (or when its failure lands in importError). It resolves AFTER persist
  // is wired, so a restored handoff is captured into the localStorage draft — which
  // is what makes stripping ?draft below safe: a refresh restores the local copy.
  const draftId = new URLSearchParams(window.location.search).get("draft");
  if (draftId === null || draftId === "") {
    store.restoreDraft(io.loadDraft());
  } else {
    // [LAW:one-source-of-truth] The ?draft handoff is single-use. On a successful
    // restore the content now lives in the localStorage draft (the persist reaction
    // above captures the restored turns), so strip ?draft from the URL: the location
    // must not stay a second authoritative copy of the editor state, or a refresh
    // would re-fetch and clobber later edits and a discard-then-refresh would
    // resurrect the discarded draft. Only on success — a failed restore keeps the id
    // so its importError stays the surfaced outcome, not silently erased.
    void store.loadServerDraft(draftId).then(() => {
      // [LAW:no-ambient-temporal-coupling] Strip ONLY when the draft was actually
      // COMMITTED (loadTurns ran), keyed on the committed state — not when it failed
      // (importError) and not when it was merely STAGED for a clobber confirmation
      // (pendingReparse holds it, awaiting the user's confirm). Keying on
      // `importError === null` alone would also strip a staged-but-uncommitted draft,
      // discarding the only recoverable handle before the restore is applied. At
      // mount the store is empty so accept always commits, but correctness must rest
      // on the committed STATE, not on that ambient "empty at mount" fact.
      if (store.importError === null && store.pendingReparse === null) stripDraftParam();
    });
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
