import type { Provider, Turn } from "./types";
import { PROVIDERS } from "./types";
import { parseClaudeShare } from "./parsers/claude-share";

// [LAW:dataflow-not-control-flow] Per-provider behavior is a table lookup, not a
// branch. Every recognized conversation host shares ONE ingestion behavior —
// fetch the link, store the original bytes, derive turns from a pure parser —
// differing only in three VALUES: the URL pattern that identifies it, the pure
// (markdown)=>Turn[] parser that projects its fetched bytes, and the DOM wait
// selector that proves the SPA hydrated before the scrape read it. This table is
// the single home of those three values per provider, mirroring parser.ts's
// PARSER_BY_KIND. [LAW:one-type-per-behavior]: providers are instances of one
// shape, never a bespoke arm or branch per host.
//
// [LAW:one-source-of-truth] A provider's accepted URL shape lives HERE only.
// isClaudeShareUrl (parser.ts), the /api/fetch re-check, and the capture-fixture
// gate all resolve through resolveProvider, so the pattern has exactly one
// definition that cannot drift across callsites.
export interface ProviderEntry {
  // The URL shape that identifies this provider. resolveProvider tests it against
  // an already-trimmed, single-line URL, so the pattern need not re-encode those
  // guards — it states only the host/path contract.
  readonly urlPattern: RegExp;
  // Pure projection of fetched markdown into turns. null = "these bytes are not a
  // conversation in this provider's format" — never a throw, never a guess
  // ([LAW:no-silent-failure]).
  readonly parser: (markdown: string) => Turn[] | null;
  // [LAW:no-ambient-temporal-coupling] The DOM selector whose presence proves the
  // client-rendered conversation hydrated — a selector wait, not a blind delay.
  // It is per-provider because each host wraps its messages in its own contract:
  // the spike (slopspot-url-ingestion-wfd.1) proved this is NOT constant —
  // chatgpt.com never renders claude.ai's [data-testid="user-message"], so a
  // single hard-coded wait timed out after 20s on that host.
  readonly waitSelector: string;
}

// [LAW:types-are-the-program] Keyed by Provider, so the type system forces
// exactly one entry per value in PROVIDERS — adding a provider to the tuple
// (types.ts) without a registry entry fails to compile. Widening the provider
// set and this table therefore land together by construction; neither can lag.
export const PROVIDER_REGISTRY: { readonly [P in Provider]: ProviderEntry } = {
  "claude-share": {
    urlPattern: /^https?:\/\/claude\.ai\/share\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i,
    parser: parseClaudeShare,
    waitSelector: '[data-testid="user-message"]',
  },
};

// [LAW:single-enforcer] The one URL→Provider resolution. Iterates PROVIDERS in
// tuple order and returns the first whose pattern matches the trimmed,
// single-line URL; null = no registered provider claims this URL. The trim +
// newline guard lives here so every caller validates a URL identically rather
// than re-deriving the rule. A null result is the caller's branch point:
// ingestPaste turns it into a typed failure today, and the fallback parser
// (slopspot-url-ingestion-wfd.4) will handle unmatched hosts.
export const resolveProvider = (url: string): Provider | null => {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) return null;
  for (const provider of PROVIDERS) {
    if (PROVIDER_REGISTRY[provider].urlPattern.test(trimmed)) return provider;
  }
  return null;
};
