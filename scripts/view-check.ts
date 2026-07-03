// First-render regression for the lit-html ?selected fix (editor-draft-cos).
//
// This file runs in its own process (see package.json "test") so that the
// jsdom DOM globals can be installed before lit-html's node build is first
// imported. The node build captures `l = globalThis.document` at module-load
// time — if globalThis.document is undefined at that moment, it falls back to a
// no-op stub and all render() calls fail. Setting up globals in this file's
// body (before any dynamic import of lit-html) guarantees the correct capture.
// [LAW:no-ambient-temporal-coupling] — explicit initialization order via
// process boundary, not relying on implicit module-load timing folklore.
//
// jsdom over happy-dom: happy-dom doesn't implement the WHATWG select
// "selectedness" algorithm correctly for disconnected elements, so
// select.value doesn't reflect ?selected attribute changes. jsdom does.

import { JSDOM } from "jsdom";
import type { Draft, DraftLoadResult, EditorIo, SubmitResult } from "../src/editor/store";
import type { HttpOutcome } from "../src/editor/mount";
import type { ParseResult } from "../src/types";

// Install jsdom globals before any lit-html import. lit-html/node/lit-html.js
// checks `void 0 === globalThis.document` at module load time; these
// assignments run before the dynamic imports below.
const jsdom = new JSDOM("<!DOCTYPE html>");
const jswindow = jsdom.window;
const setGlobal = (k: string, v: unknown): void => {
  (globalThis as Record<string, unknown>)[k] = v;
};
setGlobal("document", jswindow.document);
setGlobal("HTMLElement", jswindow.HTMLElement);
setGlobal("Node", jswindow.Node);
setGlobal("Element", jswindow.Element);
setGlobal("Text", jswindow.Text);
setGlobal("Comment", jswindow.Comment);
setGlobal("DocumentFragment", jswindow.DocumentFragment);
setGlobal("SVGElement", jswindow.SVGElement);

// Dynamic imports — lit-html and view code load AFTER DOM globals are set up.
const { render } = await import("lit-html");
const { appTemplate } = await import("../src/editor/view");
const { EditorStore } = await import("../src/editor/store");

// ── Helpers ─────────────────────────────────────────────────────────────────

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const fakeIo = (): EditorIo => ({
  fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
  fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
  submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
  navigate: () => {},
  saveDraft: () => {},
  loadDraft: (): Draft => ({ turns: [], origin: null }),
  clearDraft: () => {},
  deleteDraft: () => {},
});

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("\nView first-render select bindings (editor-draft-cos — lit-html ?selected):");
{
  // [LAW:verifiable-goals] These assertions would FAIL under the old
  // `.value=${x}` binding on <select> (lit-html sets .value before <option>
  // children exist; both role selects would show "user" and the kind badge
  // for tool-call would show "message"). They PASS only with ?selected=${... === x}
  // on each <option>.
  const store = new EditorStore(fakeIo());
  store.restoreDraft({
    turns: [
      { kind: "message", role: "assistant", content: "hello" } as const, // not first role 'user'
      { kind: "message", role: "system", content: "prompt" } as const,   // not first role 'user'
      { kind: "tool-call", tool: "bash", args: "{}", output: null } as const, // not first kind 'message'
    ],
    origin: null,
  });

  const container = jswindow.document.createElement("div");
  render(appTemplate(store), container);

  // Role selects: first role in ROLES is 'user'. Under old .value binding both
  // would show 'user'; with ?selected they show their actual role.
  const roleSelects = container.querySelectorAll<HTMLSelectElement>(".block-role");
  assert(
    'role select[0] shows "assistant" on first render (not the default "user")',
    roleSelects[0]?.value === "assistant",
  );
  assert(
    'role select[1] shows "system" on first render (not the default "user")',
    roleSelects[1]?.value === "system",
  );

  // Kind badge: first kind in KINDS is 'message'. Under old .value binding the
  // tool-call badge would show 'message'; with ?selected it shows 'tool-call'.
  const badgeSelects = container.querySelectorAll<HTMLSelectElement>(".block-badge");
  assert(
    'badge select[2] shows "tool-call" on first render (not the default "message")',
    badgeSelects[2]?.value === "tool-call",
  );
}

console.log("\nDiscard draft control (slopspot-editor-draft-rp4):");
{
  // [LAW:verifiable-goals] Three assertions pin the canDiscard gate and the
  // clearDraft side-effect — the exact acceptance criteria for this feature.
  const findDiscardBtn = (c: Element): HTMLButtonElement | undefined =>
    Array.from(c.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Discard draft",
    );

  // 1. Empty store — the button must NOT be present (canDiscard = false).
  const storeEmpty = new EditorStore(fakeIo());
  const cEmpty = jswindow.document.createElement("div");
  render(appTemplate(storeEmpty), cEmpty);
  assert('empty store: "Discard draft" control is absent', findDiscardBtn(cEmpty) === undefined);

  // 2. Store with blocks — the button IS present (canDiscard = true).
  storeEmpty.restoreDraft({
    turns: [{ kind: "message", role: "user", content: "hello" } as const],
    origin: null,
  });
  render(appTemplate(storeEmpty), cEmpty);
  assert('store with blocks: "Discard draft" control IS present', findDiscardBtn(cEmpty) !== undefined);

  // 3. After discard() + re-render — blocks empty AND clearDraft invoked.
  let clearDraftCalled = false;
  const trackIo: EditorIo = {
    ...fakeIo(),
    clearDraft: () => { clearDraftCalled = true; },
  };
  const store3 = new EditorStore(trackIo);
  store3.restoreDraft({
    turns: [{ kind: "message", role: "user", content: "content" } as const],
    origin: null,
  });
  store3.discard();
  const c3 = jswindow.document.createElement("div");
  render(appTemplate(store3), c3);
  assert("after discard(): store.blocks is empty", store3.blocks.length === 0);
  assert("after discard(): clearDraft was invoked", clearDraftCalled);
}

console.log("\nBottom submit bar (slopspot-editor-controls-csi):");
{
  // Blocks view: bottom bar present with submit button.
  const store = new EditorStore(fakeIo());
  store.restoreDraft({
    turns: [{ kind: "message", role: "user", content: "hello" } as const],
    origin: null,
  });
  const c = jswindow.document.createElement("div");
  render(appTemplate(store), c);
  const bar = c.querySelector(".editor-bottom-bar");
  assert("blocks view: bottom bar is present", bar !== null);
  const submitBtn = bar?.querySelector<HTMLButtonElement>(".btn-primary");
  assert("blocks view: bottom bar has submit button", submitBtn !== null && submitBtn !== undefined);
  assert("blocks view: bottom submit is enabled (canSubmit=true)", submitBtn?.disabled === false);

  // Empty store: bottom submit disabled (canSubmit=false).
  const storeEmpty = new EditorStore(fakeIo());
  const cEmpty = jswindow.document.createElement("div");
  render(appTemplate(storeEmpty), cEmpty);
  const emptyBtn = cEmpty.querySelector<HTMLButtonElement>(".editor-bottom-bar .btn-primary");
  assert("empty store: bottom submit is disabled (canSubmit=false)", emptyBtn?.disabled === true);

  // Click on bottom submit invokes store.submit().
  let submitCalled = false;
  const trackIo: EditorIo = {
    ...fakeIo(),
    submit: async (): Promise<SubmitResult> => { submitCalled = true; return { ok: true, slug: "x" }; },
  };
  const storeTrack = new EditorStore(trackIo);
  storeTrack.restoreDraft({
    turns: [{ kind: "message", role: "user", content: "hello" } as const],
    origin: null,
  });
  const cTrack = jswindow.document.createElement("div");
  render(appTemplate(storeTrack), cTrack);
  cTrack.querySelector<HTMLButtonElement>(".editor-bottom-bar .btn-primary")?.click();
  await new Promise<void>((r) => setTimeout(r, 10));
  assert("click on bottom submit invokes store.submit()", submitCalled);

  // Preview view: bottom bar absent.
  store.setView("preview");
  render(appTemplate(store), c);
  assert("preview view: bottom bar is absent", c.querySelector(".editor-bottom-bar") === null);
}

console.log("\nServer-draft handoff restore (slopspot-cc-share-4nc.7 — /api/draft):");
{
  // [LAW:verifiable-goals] The agent-handoff acceptance: a server draft loads into
  // the editor for review (turns become the non-dirty baseline), and a missing/
  // expired draft surfaces loudly through importError — never a silent empty editor.

  // 1. Success: fetchDraft returns a draft -> blocks populated, not dirty, no error.
  const okIo: EditorIo = {
    ...fakeIo(),
    fetchDraft: async (): Promise<DraftLoadResult> => ({
      ok: true,
      draft: { turns: [{ kind: "message", role: "user", content: "from agent" } as const], origin: null },
    }),
  };
  const okStore = new EditorStore(okIo);
  await okStore.loadServerDraft("abc123");
  assert("handoff: blocks populated from server draft", okStore.blocks.length === 1);
  assert("handoff: restored draft is not dirty (baseline set)", okStore.isDirty === false);
  assert("handoff: no importError on success", okStore.importError === null);

  // [LAW:one-source-of-truth] A saved theme override must survive the restore, or the
  // editor reopens with the wrong theme and republishes a different override than was
  // saved. A draft carrying platformOverride restores userPlatform/activePlatform.
  const themedIo: EditorIo = {
    ...fakeIo(),
    fetchDraft: async (): Promise<DraftLoadResult> => ({
      ok: true,
      draft: {
        turns: [{ kind: "message", role: "user", content: "themed" } as const],
        origin: null,
        platformOverride: "chatgpt",
      },
    }),
  };
  const themedStore = new EditorStore(themedIo);
  await themedStore.loadServerDraft("themed1");
  assert("handoff: saved platformOverride restores userPlatform", themedStore.userPlatform === "chatgpt");
  assert("handoff: restored override drives activePlatform", themedStore.activePlatform === "chatgpt");

  // A draft with no override snaps theme to auto-detection (userPlatform null) — the
  // existing fresh-content behavior is preserved as a value, not a branch.
  assert("handoff: draft without override leaves userPlatform null (auto)", okStore.userPlatform === null);

  // 2. Failure: an expired/unknown draft id -> importError set, editor stays empty.
  const failIo: EditorIo = {
    ...fakeIo(),
    fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "This draft has expired or was not found." }),
  };
  const failStore = new EditorStore(failIo);
  await failStore.loadServerDraft("missing");
  assert("handoff: expired draft sets importError (loud, not silent)", failStore.importError === "This draft has expired or was not found.");
  assert("handoff: expired draft leaves editor empty", failStore.blocks.length === 0);

  // [LAW:effects-at-boundaries][LAW:no-silent-failure] The SHIPPING boundary must be
  // total: a transport rejection (offline/DNS/abort) becomes a typed {ok:false},
  // never an escaped rejection — otherwise it would propagate out of loadServerDraft
  // (which set busy=true) and strand the editor busy with a blank screen.
  const { fetchDraft, decodeJson } = await import("../src/editor/mount");
  const origFetch = globalThis.fetch;
  setGlobal("fetch", async (): Promise<Response> => {
    throw new TypeError("Failed to fetch");
  });
  let rejected = false;
  let boundaryResult: DraftLoadResult = { ok: false, reason: "sentinel" };
  try {
    boundaryResult = await fetchDraft("any-id");
  } catch {
    rejected = true;
  }
  setGlobal("fetch", origFetch);
  assert("boundary: a rejected fetch does NOT throw out of fetchDraft", rejected === false);
  assert("boundary: a rejected fetch resolves to a typed {ok:false}", boundaryResult.ok === false);
  assert(
    "boundary: a rejected fetch reports a transport reason (not 'expired')",
    boundaryResult.ok === false && boundaryResult.reason === "Couldn't reach the server to load the draft.",
  );

  // [LAW:no-silent-failure][LAW:verifiable-goals] decodeJson is the PURE classifier:
  // each failure mode gets its OWN reason, so transport/5xx/malformed are never
  // collapsed into the 404 "expired" message. Tested directly — no fetch needed.
  const reasons = { transport: "T", server: "S", malformed: "M" };
  const dec = (o: HttpOutcome) => decodeJson(o, reasons);
  assert("decodeJson: transport-error -> transport reason", (() => { const r = dec({ kind: "transport-error" }); return !r.ok && r.reason === "T"; })());
  assert("decodeJson: 404 with body.error -> server's own text (sourced once)", (() => { const r = dec({ kind: "response", status: 404, body: { error: "gone" } }); return !r.ok && r.reason === "gone"; })());
  assert("decodeJson: 5xx with no body -> generic server reason (NOT expired)", (() => { const r = dec({ kind: "response", status: 503, body: null }); return !r.ok && r.reason === "S"; })());
  assert("decodeJson: 2xx with non-object body -> malformed reason", (() => { const r = dec({ kind: "response", status: 200, body: null }); return !r.ok && r.reason === "M"; })());
  assert("decodeJson: clean 2xx object body -> ok with data", (() => { const r = dec({ kind: "response", status: 200, body: { slug: "x" } }); return r.ok && r.data.slug === "x"; })());
}

console.log("\nclaude.ai/code link handoff affordance (slopspot-cc-share-4nc.9):");
{
  // [LAW:verifiable-goals] Pasting a claude.ai/code link shows the honest
  // temporary-workaround notice + copyable handoff and SUPPRESSES the doomed
  // fetch button; a normal link keeps the fetch affordance and shows no notice.
  const store = new EditorStore(fakeIo());
  store.setImport("https://claude.ai/code/session_01E1cdheWtrieG1o6dhhFAJu");
  const c = jswindow.document.createElement("div");
  render(appTemplate(store), c);
  assert("code link: temporary-workaround notice renders", c.querySelector(".code-link-notice") !== null);
  assert("code link: copyable instructions present", c.querySelector(".code-link-prompt") !== null);
  assert("code link: doomed fetch row is suppressed", c.querySelector(".import-row") === null);

  // A normal (non-code) link keeps the fetch affordance and shows no notice.
  store.setImport("https://claude.ai/share/abc123");
  render(appTemplate(store), c);
  assert("share link: no code-link notice", c.querySelector(".code-link-notice") === null);
  assert("share link: fetch row present", c.querySelector(".import-row") !== null);
}

console.log("\nSingle-turn card render target (slopspot-permalinks-64g.3):");
{
  // [LAW:verifiable-goals] The card renders exactly one turn, through the SAME
  // renderer the full page uses, keeping the turn's TRUE t<N> identity; an
  // out-of-range or non-canonical segment is an honest absence (404), never a
  // fallback to turn 0 or the whole paste.
  const { deriveDialogue } = await import("../src/dialogue");
  const { renderDialogueHtml } = await import("../src/renderDialogue");
  const { renderTurnCard } = await import("../src/turnCard");

  // Three spine turns: user(0), assistant(1), user(2).
  const dialogue = deriveDialogue([
    { kind: "message", role: "user", content: "first question" } as const,
    { kind: "message", role: "assistant", content: "an answer" } as const,
    { kind: "message", role: "user", content: "second question" } as const,
  ]);

  const t0 = renderTurnCard(dialogue, "t0");
  const t2 = renderTurnCard(dialogue, "t2");

  assert("card t0 renders and carries its content", t0 !== null && t0.includes("first question"));
  assert("card t0 carries id=\"t0\"", t0 !== null && t0.includes('id="t0"'));

  // The core decision: a sliced turn keeps its TRUE index, not the t0 a bare
  // 1-element slice would reset it to [LAW:one-source-of-truth].
  assert("card t2 carries id=\"t2\" (true index, not reset to t0)", t2 !== null && t2.includes('id="t2"'));
  assert("card t2 does NOT carry id=\"t0\"", t2 !== null && !t2.includes('id="t0"'));
  assert("card t2 renders its own content", t2 !== null && t2.includes("second question"));

  // [LAW:single-enforcer] The card is drawn by the SAME renderer, so turn 2's card
  // markup is byte-identical to turn 2 inside the full page — a substring of it.
  const full = renderDialogueHtml(dialogue);
  assert("card t2 is a verbatim substring of the full-page render (one renderer)", t2 !== null && full.includes(t2));

  // [LAW:no-silent-failure] Out-of-range and non-canonical segments are null (404),
  // never a fallback.
  assert("index past the spine → null (out-of-range 404)", renderTurnCard(dialogue, "t3") === null);
  assert("non-canonical leading-zero segment → null", renderTurnCard(dialogue, "t007") === null);
  assert("non-numeric segment → null", renderTurnCard(dialogue, "tx") === null);
  assert("missing t prefix → null", renderTurnCard(dialogue, "2") === null);
  assert("bare prefix → null", renderTurnCard(dialogue, "t") === null);
}

console.log("\nTopic spine outline (slopspot-summary-daf.1):");
{
  // [LAW:verifiable-goals] The outline is a pure projection of the derived Dialogue:
  // one entry per spine node, each anchored to that node's t<N> id and labeled from
  // its own text. The load-bearing invariant is [LAW:one-source-of-truth] — the
  // outline's anchor EQUALS the id the renderer emits, and its label EQUALS the
  // data-topic the renderer emits — so the static outline, the permalink, and the
  // minimap marker all name a turn identically and cannot drift.
  const { deriveDialogue } = await import("../src/dialogue");
  const { renderDialogueHtml } = await import("../src/renderDialogue");
  const { deriveSpineOutline } = await import("../src/spineOutline");

  const dialogue = deriveDialogue([
    { kind: "message", role: "user", content: "first question" } as const,
    { kind: "message", role: "assistant", content: "an answer" } as const,
    { kind: "message", role: "user", content: "second question" } as const,
  ]);
  const outline = deriveSpineOutline(dialogue);
  const full = renderDialogueHtml(dialogue);

  assert("outline has one entry per spine node", outline.length === 3);
  assert(
    "entries carry index/anchor/role/label in source order",
    outline[0]?.index === 0 && outline[0]?.anchor === "t0" && outline[0]?.role === "user" && outline[0]?.label === "first question" &&
    outline[1]?.role === "assistant" && outline[1]?.label === "an answer" &&
    outline[2]?.anchor === "t2" && outline[2]?.role === "user" && outline[2]?.label === "second question",
  );

  // [LAW:one-source-of-truth] Every entry's anchor is an id the renderer actually
  // emitted, and every entry's label is the data-topic the renderer actually emitted.
  const anchorsResolve = outline.every((e) => full.includes(`id="${e.anchor}"`));
  const labelsMatchTopic = outline.every((e) => full.includes(`data-topic="${e.label}"`));
  assert("every outline anchor resolves to a rendered t<N> id", anchorsResolve);
  assert("every outline label equals the node's rendered data-topic", labelsMatchTopic);

  // [LAW:no-silent-failure] An assistant turn carrying no prose (only a tool call)
  // still yields a NON-EMPTY, honest label (the tool name) — never a blank row.
  const toolOnly = deriveSpineOutline(
    deriveDialogue([
      { kind: "message", role: "user", content: "run it" } as const,
      { kind: "tool-call", tool: "bash", args: "{}", output: null } as const,
    ]),
  );
  assert(
    "assistant turn with only a tool call labels from the tool name (non-empty)",
    toolOnly[1]?.role === "assistant" && toolOnly[1]?.label === "bash",
  );

  // Structural snippet: whitespace collapses and an over-long label is truncated to a
  // bounded length with an ellipsis — a legible topic, not a paragraph.
  const long = "x".repeat(200);
  const shaped = deriveSpineOutline(
    deriveDialogue([{ kind: "message", role: "user", content: `line one\n\n  ${long}` } as const]),
  );
  const label = shaped[0]?.label ?? "";
  assert("over-long label is truncated with an ellipsis", label.length <= 80 && label.endsWith("…"));
  assert("whitespace collapses (no newline survives in the label)", !label.includes("\n"));
}

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll view checks passed.");
}
