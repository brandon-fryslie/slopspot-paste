import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { parseAuto, parseInput, deriveTitle } from "../../parser";
import { putConversation } from "../../storage";
import { generateSlug } from "../../slug";
import type { Conversation, ParseResult, PasteInput, SourceKind } from "../../types";
import { SOURCE_KINDS, TTL_SECONDS } from "../../types";

export const prerender = false;

// [LAW:single-enforcer] All validation lives at this trust boundary.
// Downstream code (storage, render) trusts the typed PasteInput / Conversation.
// [LAW:no-defensive-null-guards] The shape-narrowing below is the legitimate
// kind of guard — this IS the trust boundary; unknown JSON from the wire has
// to be classified into one of the typed cases.

const MAX_BYTES = 256 * 1024; // 256 KB
const MAX_TURNS = 1000;

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === "string" && (SOURCE_KINDS as ReadonlyArray<string>).includes(v);

const isPasteInput = (v: unknown): v is PasteInput => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; content?: unknown };
  return isSourceKind(o.kind) && typeof o.content === "string";
};

// [LAW:dataflow-not-control-flow] One decode path returns one tagged value.
// Downstream branches on the tag, never on "did the request have a source
// field?" scattered across the file.
type DecodedRequest =
  | { ok: true; input: PasteInput }
  | { ok: true; legacy: string }
  | { ok: false; reason: string };

const decodeRequest = async (request: Request): Promise<DecodedRequest> => {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as
      | { source?: unknown; content?: unknown }
      | null;
    if (body && isPasteInput(body.source)) return { ok: true, input: body.source };
    if (body && typeof body.content === "string") return { ok: true, legacy: body.content };
    return { ok: false, reason: "Missing 'source' or 'content' field." };
  }
  const form = await request.formData().catch(() => null);
  const content = form?.get("content");
  const kind = form?.get("source");
  if (typeof content !== "string") {
    return { ok: false, reason: "Missing 'content' field." };
  }
  if (isSourceKind(kind)) {
    return { ok: true, input: { kind, content } as PasteInput };
  }
  return { ok: true, legacy: content };
};

const sizeOf = (s: string): number => new Blob([s]).size;

export const POST: APIRoute = async ({ request }) => {
  const decoded = await decodeRequest(request);
  if (!decoded.ok) return json(400, { error: decoded.reason });

  const rawSize = "input" in decoded ? sizeOf(decoded.input.content) : sizeOf(decoded.legacy);
  if (rawSize === 0) return json(400, { error: "Empty paste." });
  if (rawSize > MAX_BYTES) {
    return json(413, { error: `Paste exceeds ${MAX_BYTES} bytes.` });
  }

  const parsed: ParseResult =
    "input" in decoded ? parseInput(decoded.input) : parseAuto(decoded.legacy);
  if (!parsed.ok) return json(400, { error: parsed.reason });
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
