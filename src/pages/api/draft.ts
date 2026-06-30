import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ingestRequest } from "../../ingest-request";
import { putDraft, getDraft, deleteDraft } from "../../storage";
import { generateSlug } from "../../slug";
import { json } from "../../http";

export const prerender = false;

// [LAW:composability] /api/draft IS /api/paste minus the publish commitment: the
// SAME validated ingest pipeline (ingestRequest), but the tail stores a short-TTL
// draft and returns an editor URL that opens the conversation UNSUBMITTED for
// review, instead of minting a permanent slug. The user reviews, then the editor
// publishes through /api/paste unchanged.
//
// This is the seam an agent uses: the user's own agent extracts a Claude Code
// session (which slopspot cannot fetch server-side yet — Cloudflare blocks
// non-browser clients and claude_code_web is platform-gated) and POSTs it here,
// then opens the returned URL so the user reviews before publishing.
// [LAW:single-enforcer] /share-slop and the inline copy-paste prompt are two
// surfaces of this one endpoint.
export const POST: APIRoute = async ({ request }) => {
  const result = await ingestRequest(request, env);
  if (!result.ok) return json(result.status, { error: result.error });
  const draftId = generateSlug();
  await putDraft(env.PASTES, draftId, {
    turns: result.parsed.turns,
    origin: result.parsed.origin,
    platformOverride: result.platformOverride,
  });
  // The editor restores ?draft=<id> on load (mount.ts) and shows it unsubmitted.
  return json(200, { draftId, url: "/?draft=" + draftId });
};

// [LAW:no-silent-failure] A missing or expired draft is an explicit 404, never a
// silent empty editor — the editor surfaces it as a loud import error.
export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get("id");
  if (id === null || id === "") return json(400, { error: "Missing draft id." });
  const draft = await getDraft(env.PASTES, id);
  if (draft === null) return json(404, { error: "This draft has expired or was not found." });
  return json(200, { turns: draft.turns, origin: draft.origin, platformOverride: draft.platformOverride });
};

// [LAW:no-silent-failure] Revoke a handoff draft immediately on discard, rather than
// leaving it to expire on its TTL. [LAW:single-enforcer] Mirrors the soft-delete
// endpoint's idempotency: deleting an absent/expired/never-stored id is a no-op that
// returns 200, because the outcome (no draft with this id) is already reached — a
// missing id is success, not a 404. Only a structurally invalid request (no id) is a
// 400. The draft URL is single-use and the TTL bounds exposure, so this is hardening.
export const DELETE: APIRoute = async ({ url }) => {
  const id = url.searchParams.get("id");
  if (id === null || id === "") return json(400, { error: "Missing draft id." });
  await deleteDraft(env.PASTES, id);
  return json(200, { id });
};
