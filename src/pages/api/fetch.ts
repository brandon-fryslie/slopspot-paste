import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ingestPaste, isClaudeShareUrl } from "../../parser";
import { json } from "../../http";
import type { ParseResult } from "../../types";
import { sourceOf } from "../../types";

export const prerender = false;

// [LAW:effects-at-boundaries] The Firecrawl fetch is a server-only effect. This
// route exists so the URL→turns ingestion runs where env.FIRECRAWL_API_KEY
// lives — the key never reaches the browser. The editor calls this, gets back
// a Turn[], edits it, and submits the *edited* turns to /api/paste; the page
// is never re-fetched at store time.
//
// [LAW:single-enforcer] URL validation + the size cap on fetched content live
// inside ingestPaste (shared with /api/paste's claude-share arm). This route
// re-checks isClaudeShareUrl first so a non-URL body fails fast with a clear
// message instead of paying for a Firecrawl round-trip on garbage input.
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
  const url = body?.url;
  if (typeof url !== "string" || !isClaudeShareUrl(url)) {
    return json(400, { error: "Expected a claude.ai/share URL." });
  }

  const parsed: ParseResult = await ingestPaste({ kind: "claude-share", url }, env);
  if (!parsed.ok) return json(400, { error: parsed.reason });

  // [LAW:one-source-of-truth] The editor round-trips this provenance back to
  // /api/paste at submit time — it never re-derives "this came from a share URL".
  // `source` is derived from the captured origin; the share `fetched` bytes stay
  // server-side (the editor submits its edited turns, not the origin).
  return json(200, { turns: parsed.turns, source: sourceOf(parsed.origin) });
};
