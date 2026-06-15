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

// [LAW:single-enforcer] One timeout governs the ingestion fetch. Without it a
// stalled Firecrawl ties up the Worker until the platform ceiling; this fails
// fast with a typed reason so the caller's ok:false path runs predictably.
const FIRECRAWL_TIMEOUT_MS = 20_000;

interface ScrapeResponse {
  readonly success?: boolean;
  readonly data?: { readonly markdown?: string };
  readonly error?: string;
}

// [LAW:effects-at-boundaries] Pure request body — testable without mocking
// fetch. [LAW:no-ambient-temporal-coupling] A selector wait rather than a
// blind millisecond delay: claude.ai/share is a client-rendered SPA whose
// user messages appear under [data-testid="user-message"]; waiting on that
// selector guarantees hydration without racing the clock.
export const scrapeRequestBody = (url: string) => ({
  url,
  formats: ["markdown"],
  actions: [{ type: "wait" as const, selector: '[data-testid="user-message"]' }],
});

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

  // [LAW:types-are-the-program] The catch returns the rejection value, then
  // `instanceof Response` narrows success from failure — a timeout (DOMException
  // TimeoutError from AbortSignal.timeout) becomes a distinct typed reason.
  const response = await fetch(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(scrapeRequestBody(url)),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  }).catch((e: unknown): unknown => e);

  if (!(response instanceof Response)) {
    const timedOut = response instanceof DOMException && response.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut
        ? `Firecrawl request timed out after ${FIRECRAWL_TIMEOUT_MS / 1000}s.`
        : "Firecrawl request failed (network error).",
    };
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
