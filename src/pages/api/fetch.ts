import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ingestPaste, isClaudeShareUrl } from "../../parser";
import { json } from "../../http";
import type { ParseResult } from "../../types";

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

  const parsed: ParseResult = await ingestPaste({ kind: "url", url }, env);
  if (!parsed.ok) return json(400, { error: parsed.reason });

  // [LAW:one-source-of-truth] Return the captured Origin verbatim — the link AND
  // the fetched bytes — not a narrowed `source`. The editor carries this whole
  // source of truth and round-trips it back to /api/paste at submit time, so a
  // pristine share import is stored as a replayable url origin (its link
  // displayed, its bytes re-projectable, its provider tagged) rather than
  // collapsing to an editor origin that discarded where it came from.
  return json(200, { turns: parsed.turns, origin: parsed.origin });
};
