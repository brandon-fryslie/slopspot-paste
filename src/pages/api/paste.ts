import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { parseAuto, ingestPaste, deriveTitle } from "../../parser";
import { putConversation } from "../../storage";
import { generateSlug } from "../../slug";
import { json, seeOther } from "../../http";
import type { Conversation, ParseResult, PasteInput, SourceKind, Turn } from "../../types";
import { inputText, isTurns, lifetimeFromChoice, MAX_PASTE_BYTES, MAX_PASTE_LABEL, SOURCE_KINDS, textArmInput } from "../../types";

export const prerender = false;

// [LAW:single-enforcer] All validation lives at this trust boundary.
// Downstream code (storage, render) trusts the typed PasteInput / Conversation.
// [LAW:no-defensive-null-guards] The shape-narrowing below is the legitimate
// kind of guard — this IS the trust boundary; unknown JSON from the wire has
// to be classified into one of the typed cases.

// [LAW:single-enforcer] One size cap for every kind, stated once in types.ts
// (MAX_PASTE_BYTES) so the API limit and the page's advertised limit share a
// source. 8 MiB gives honest headroom for JSON-encoding overhead on long CC
// session JSONL (observed at 1.74 MB) while staying under KV's 25 MB ceiling.
const MAX_TURNS = 10000;

const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === "string" && (SOURCE_KINDS as ReadonlyArray<string>).includes(v);

// [LAW:types-are-the-program] The trust boundary classifies wire JSON into
// one of the union arms. Each arm's required field is checked against its
// kind — a claude-share payload without `url` (or any other arm without
// `content`) fails here instead of crashing downstream.
const isPasteInput = (v: unknown): v is PasteInput => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; content?: unknown; url?: unknown };
  if (!isSourceKind(o.kind)) return false;
  if (o.kind === "claude-share") return typeof o.url === "string";
  return typeof o.content === "string";
};

// [LAW:dataflow-not-control-flow] One decode path returns one tagged value.
// Downstream branches on the tag, never on "did the request have a source
// field?" scattered across the file.
type DecodedRequest =
  | { ok: true; input: PasteInput }
  | { ok: true; turns: ReadonlyArray<Turn> }
  | { ok: true; legacy: string }
  | { ok: false; reason: string };

const decodeRequest = async (request: Request): Promise<DecodedRequest> => {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as
      | { source?: unknown; content?: unknown; turns?: unknown }
      | null;
    // [LAW:single-enforcer] The editor arm: a pre-parsed, user-edited Turn[]
    // validated here at the one boundary, then stored without re-parsing.
    // isTurns rejects every illegal shape so downstream trusts the typed value.
    if (body && isTurns(body.turns)) return { ok: true, turns: body.turns };
    if (body && isPasteInput(body.source)) return { ok: true, input: body.source };
    if (body && typeof body.content === "string") return { ok: true, legacy: body.content };
    return { ok: false, reason: "Missing 'turns', 'source' or 'content' field." };
  }
  const form = await request.formData().catch(() => null);
  const kind = form?.get("source");
  // The form encoding only carries text arms; URL arms are JSON-only (the
  // browser script always submits JSON). The `<form action="/api/paste">`
  // fallback exists for users with JS disabled or external clients.
  const content = form?.get("content");
  if (typeof content !== "string") {
    return { ok: false, reason: "Missing 'content' field." };
  }
  // No recognized source kind → legacy path (direct API callers without a
  // source field). Checking this first lets the claude-share guard below narrow
  // kind to a text arm, so textArmInput is built without a cast.
  if (!isSourceKind(kind)) {
    return { ok: true, legacy: content };
  }
  // [LAW:no-silent-fallbacks] claude-share is a URL arm that only the JS submit
  // path (JSON { url }) can fulfill. A form-encoded claude-share request fails
  // loudly here instead of being silently re-routed to parseAuto, which would
  // render the URL as a raw bubble — the opposite of what the user asked for.
  if (kind === "claude-share") {
    return {
      ok: false,
      reason: "claude.ai/share URLs require JavaScript enabled (they're fetched via the JSON submit path).",
    };
  }
  return { ok: true, input: textArmInput(kind, content) };
};

const sizeOf = (s: string): number => new Blob([s]).size;

export const POST: APIRoute = async ({ request }) => {
  // [LAW:dataflow-not-control-flow] The success response modality is data
  // derived from the request's content-type — the same predicate decodeRequest
  // keys on. A form-encoded POST is the no-JS <form> (a browser navigation), so
  // success redirects to the rendered paste; a JSON POST is the editor/API and
  // gets { slug }. One store path, two representations. (Error bodies stay JSON
  // for both — a no-JS error shows the readable `error` string, not a redirect.)
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const decoded = await decodeRequest(request);
  if (!decoded.ok) return json(400, { error: decoded.reason });

  // [LAW:single-enforcer] One size cap, one place. Each arm names the bytes it
  // puts at risk: the user-supplied string for input/legacy (url or content,
  // via inputText), and the serialized turns for the editor arm — those bytes
  // ARE the stored payload, since edited turns are not re-parsed. A 200 MB URL
  // or a 200 MB block list is rejected here, not in firecrawl or KV.
  const rawSize =
    "input" in decoded
      ? sizeOf(inputText(decoded.input))
      : "turns" in decoded
        ? sizeOf(JSON.stringify(decoded.turns))
        : sizeOf(decoded.legacy);
  if (rawSize === 0) return json(400, { error: "Empty paste." });
  if (rawSize > MAX_PASTE_BYTES) {
    return json(413, { error: `Paste exceeds the ${MAX_PASTE_LABEL} limit (${MAX_PASTE_BYTES} bytes).` });
  }

  // [LAW:single-enforcer] Every arm converges to one ParseResult before the
  // shared store tail. ingestPaste handles sync text parsing and async URL
  // ingestion; the editor arm is already a validated Turn[] (isTurns ran at the
  // decode boundary), so it becomes a ParseResult directly — the server never
  // re-parses edited blocks. The kind discrimination stays inside the parser.
  const parsed: ParseResult =
    "input" in decoded
      ? await ingestPaste(decoded.input, env)
      : "turns" in decoded
        ? { ok: true, turns: decoded.turns }
        : parseAuto(decoded.legacy);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  // [LAW:dataflow-not-control-flow] Every arm flows through the same turn-count
  // bounds. For text/URL these are no-ops (a parse always yields ≥1 turn), but
  // the editor arm can submit an empty block list — caught here as the same
  // "empty paste" condition, not a special case bolted onto one arm.
  if (parsed.turns.length === 0) return json(400, { error: "Empty paste." });
  if (parsed.turns.length > MAX_TURNS) {
    return json(413, { error: `Too many turns (max ${MAX_TURNS}).` });
  }

  const now = Date.now();
  const conversation: Conversation = {
    slug: generateSlug(),
    createdAt: now,
    lifetime: lifetimeFromChoice("expires", now),
    turns: parsed.turns,
    title: deriveTitle(parsed.turns),
  };

  await putConversation(env.PASTES, conversation);
  return wantsRedirect
    ? seeOther("/" + conversation.slug)
    : json(200, { slug: conversation.slug });
};
