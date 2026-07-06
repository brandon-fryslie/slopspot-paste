// [LAW:single-enforcer] The one gate that resolves a public, viewable paste from a
// slug. Every reader surface — the full page and the single-turn card render target
// — goes through here, so the "is this paste allowed to be shown" invariant is
// enforced at exactly one boundary and cannot drift between routes. If it drifted, a
// soft-deleted or expired paste could 410 on /<slug> yet still render on /<slug>/t3.
//
// [LAW:one-way-deps] loadPaste depends on storage (fetch), slug (validity) and types
// (the hidden-from-public rule); none depend back on it.
// [LAW:no-silent-failure] Absence is a typed, discriminated result carrying the HTTP
// status and message — never a null the caller might read as an empty conversation.

import type { Conversation, PasteLoad } from "./types";
import { getConversation } from "./storage";
import { isValidSlug } from "./slug";
import { isHiddenFromPublic } from "./types";

// [LAW:one-source-of-truth] PasteLoad — the discriminated result of this gate — is the
// PURE contract callers depend on, so it lives in types.ts (the shared type home)
// rather than coupled to this Worker-IO module. The pure diff core (src/diff.ts)
// consumes it without dragging KVNamespace into the Node/jsdom scripts world.
export type { PasteLoad };

export const loadViewablePaste = async (
  kv: KVNamespace,
  slug: string | undefined,
  now: number,
): Promise<PasteLoad> => {
  // [LAW:dataflow-not-control-flow] Each rejection is a value the boundary returns,
  // not a branch that skips work: an invalid slug, a missing record, and a hidden
  // record each map to their own {ok:false} case, and the happy path falls out last.
  if (!slug || !isValidSlug(slug)) {
    return { ok: false, status: 404, message: "Not found" };
  }
  // [LAW:no-silent-failure] getConversation catches only its JSON.parse; a kv.get
  // rejection (transient KV error — quota, internal) would otherwise escape this
  // gate as an unhandled rejection and break its totality. Catch it here and surface
  // it AS a storage failure: a distinct, retryable 503 — NOT a 404, which would
  // misrepresent an infra failure as "this paste never existed" (the meaning-altering
  // fallback the law forbids). The error is logged, not swallowed — the loud 503 is
  // the reader's surface, the log is the operator's.
  let conversation: Conversation | null;
  try {
    conversation = await getConversation(kv, slug);
  } catch (err) {
    console.error(`loadViewablePaste: storage read failed for slug ${slug}:`, err);
    return { ok: false, status: 503, message: "The paste store is temporarily unavailable. Please try again." };
  }
  if (!conversation) {
    return { ok: false, status: 404, message: "This paste has expired or never existed." };
  }
  if (isHiddenFromPublic(conversation, now)) {
    return { ok: false, status: 410, message: "This paste has expired or been deleted." };
  }
  return { ok: true, conversation };
};
