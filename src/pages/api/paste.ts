import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { parsePaste, deriveTitle } from "../../parser";
import { putConversation } from "../../storage";
import { generateSlug } from "../../slug";
import type { Conversation } from "../../types";
import { TTL_SECONDS } from "../../types";

export const prerender = false;

// [LAW:single-enforcer] All validation lives at this trust boundary.
// Downstream code (storage, render) trusts the typed Conversation.

const MAX_BYTES = 256 * 1024; // 256 KB
const MAX_TURNS = 1000;

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const POST: APIRoute = async ({ request }) => {
  const ct = request.headers.get("content-type") ?? "";
  let content: unknown;
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
    content = body?.content;
  } else {
    const form = await request.formData().catch(() => null);
    content = form?.get("content");
  }

  if (typeof content !== "string") {
    return json(400, { error: "Missing 'content' field." });
  }
  if (content.length === 0) {
    return json(400, { error: "Empty paste." });
  }
  if (new Blob([content]).size > MAX_BYTES) {
    return json(413, { error: `Paste exceeds ${MAX_BYTES} bytes.` });
  }

  const parsed = parsePaste(content);
  if (!parsed.ok) {
    return json(400, { error: parsed.reason });
  }
  if (parsed.turns.length > MAX_TURNS) {
    return json(413, { error: `Too many turns (max ${MAX_TURNS}).` });
  }

  const now = Date.now();
  const conversation: Conversation = {
    slug: generateSlug(),
    createdAt: now,
    expiresAt: now + TTL_SECONDS * 1000,
    turns: parsed.turns,
    title: deriveTitle(parsed.turns),
  };

  await putConversation(env.PASTES, conversation);
  return json(200, { slug: conversation.slug });
};
