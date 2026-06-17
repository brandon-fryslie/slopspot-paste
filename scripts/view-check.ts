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
import type { Draft, EditorIo, SubmitResult } from "../src/editor/store";
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
  submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
  navigate: () => {},
  saveDraft: () => {},
  loadDraft: (): Draft => ({ turns: [], origin: null }),
  clearDraft: () => {},
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

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll view checks passed.");
}
