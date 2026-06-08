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

import { autorun } from "mobx";
import { render } from "lit-html";
import type { ParseResult, Turn } from "../types";
import { isTurns } from "../types";
import { EditorStore, type EditorIo, type SubmitResult } from "./store";
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
    | { turns?: unknown; error?: unknown }
    | null;
  if (!res.ok || data === null) {
    return { ok: false, reason: errorText(data, "Failed to fetch the URL.") };
  }
  if (!isTurns(data.turns)) {
    return { ok: false, reason: "Malformed response from /api/fetch." };
  }
  return { ok: true, turns: data.turns };
};

const submit = async (turns: ReadonlyArray<Turn>): Promise<SubmitResult> => {
  const res = await fetch("/api/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turns }),
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

export const mountEditor = (rootSelector = "#editor-root"): EditorStore => {
  const root = must(rootSelector, HTMLElement);
  const io: EditorIo = {
    fetchShare,
    submit,
    navigate: (slug) => window.location.assign("/" + slug),
  };
  const store = new EditorStore(io);
  // [LAW:no-ambient-temporal-coupling] mobx's autorun is the single render
  // owner: it runs once now and again whenever any observable the template reads
  // changes. Render order is not folklore — it's whatever the reactive graph
  // dictates, with one explicit scheduler.
  autorun(() => render(appTemplate(store), root));
  return store;
};
