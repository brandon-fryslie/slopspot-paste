// [LAW:single-enforcer] This file is the ONE place the Firecrawl wire format
// lives. The rest of the codebase asks for "markdown rendered from a URL"; if
// Firecrawl's request shape, base URL, or response envelope changes, only this
// file changes.
//
// [LAW:types-are-the-program] FirecrawlResult is a discriminated union — every
// failure mode is a representable value, no throws across the module boundary.
// Callers structurally handle ok vs not-ok; there is no third state.

export type FirecrawlResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly reason: string };

export interface FirecrawlEnv {
  readonly FIRECRAWL_API_KEY?: string;
}

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

interface ScrapeResponse {
  readonly success?: boolean;
  readonly data?: { readonly markdown?: string };
  readonly error?: string;
}

// [LAW:no-defensive-null-guards] This IS a trust boundary — Firecrawl is an
// external service whose response shape we cannot prove. The guards below
// classify the wire payload into the typed union and stop. Downstream code
// receives a structurally valid value.
export const firecrawlScrape = async (
  url: string,
  env: FirecrawlEnv,
): Promise<FirecrawlResult> => {
  const key = env.FIRECRAWL_API_KEY;
  if (!key) {
    return {
      ok: false,
      reason:
        "URL ingestion is not configured (FIRECRAWL_API_KEY missing). " +
        "Set the secret via `wrangler secret put FIRECRAWL_API_KEY`.",
    };
  }

  const response = await fetch(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ url, formats: ["markdown"] }),
  }).catch((e: unknown): null => {
    void e;
    return null;
  });

  if (response === null) {
    return { ok: false, reason: "Firecrawl request failed (network error)." };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `Firecrawl returned HTTP ${response.status}.`,
    };
  }

  const body = (await response.json().catch(() => null)) as ScrapeResponse | null;
  if (body === null) {
    return { ok: false, reason: "Firecrawl response was not JSON." };
  }
  if (body.success !== true) {
    return {
      ok: false,
      reason: `Firecrawl reported failure: ${body.error ?? "unknown"}.`,
    };
  }
  const md = body.data?.markdown;
  if (typeof md !== "string" || md.length === 0) {
    return { ok: false, reason: "Firecrawl returned no markdown for this URL." };
  }
  return { ok: true, markdown: md };
};
