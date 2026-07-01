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

import type { Conversation } from "./types";
import { getConversation } from "./storage";
import { isValidSlug } from "./slug";
import { isHiddenFromPublic } from "./types";

// [LAW:types-are-the-program] The two viewable-paste outcomes: the conversation, or
// the exact response the boundary must emit. 404 "never existed / bad slug" is kept
// distinct from 410 "existed but is gone" — HTTP semantics for the tombstone state.
export type PasteLoad =
  | { readonly ok: true; readonly conversation: Conversation }
  | { readonly ok: false; readonly status: 404 | 410; readonly message: string };

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
  const conversation = await getConversation(kv, slug);
  if (!conversation) {
    return { ok: false, status: 404, message: "This paste has expired or never existed." };
  }
  if (isHiddenFromPublic(conversation, now)) {
    return { ok: false, status: 410, message: "This paste has expired or been deleted." };
  }
  return { ok: true, conversation };
};
