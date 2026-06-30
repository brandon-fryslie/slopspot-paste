import type { Provider, Turn } from "./types";
import { PROVIDERS } from "./types";
import type { WaitStrategy } from "./firecrawl";
import { parseClaudeShare } from "./parsers/claude-share";
import { parseChatgptShare } from "./parsers/chatgpt-share";
import { singleLineUrl } from "./url";

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
// ingestPaste, reprojectOrigin, and the capture-fixture gate all resolve through
// resolveProvider, so the pattern has exactly one definition that cannot drift
// across callsites. (Detection and the /api/fetch re-check use the generic isUrl,
// which recognizes ANY link; the provider pattern only chooses the parser after
// fetch.)
export interface ProviderEntry {
  // The URL shape that identifies this provider. resolveProvider tests it against
  // an already-trimmed, single-line URL, so the pattern need not re-encode those
  // guards — it states only the host/path contract.
  readonly urlPattern: RegExp;
  // Pure projection of fetched markdown into turns. null = "these bytes are not a
  // conversation in this provider's format" — never a throw, never a guess
  // ([LAW:no-silent-failure]).
  readonly parser: (markdown: string) => Turn[] | null;
  // [LAW:no-ambient-temporal-coupling] How to wait for this host's client-rendered
  // conversation to hydrate before the scrape reads it. A known provider uses a
  // `selector` strategy — the DOM node that proves its messages rendered — because
  // each host wraps its messages in its own contract: the spike
  // (slopspot-url-ingestion-wfd.1) proved this is NOT constant — chatgpt.com never
  // renders claude.ai's [data-testid="user-message"], so a single hard-coded wait
  // timed out after 20s on that host. (The unclaimed-host fallback uses the
  // selector-less `settle` strategy — see FALLBACK_WAIT.)
  readonly wait: WaitStrategy;
}

// [LAW:types-are-the-program] Keyed by Provider, so the type system forces
// exactly one entry per value in PROVIDERS — adding a provider to the tuple
// (types.ts) without a registry entry fails to compile. Widening the provider
// set and this table therefore land together by construction; neither can lag.
export const PROVIDER_REGISTRY: { readonly [P in Provider]: ProviderEntry } = {
  "claude-share": {
    urlPattern: /^https?:\/\/claude\.ai\/share\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i,
    parser: parseClaudeShare,
    wait: { kind: "selector", selector: '[data-testid="user-message"]' },
  },
  "chatgpt-share": {
    urlPattern: /^https?:\/\/chatgpt\.com\/share\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i,
    parser: parseChatgptShare,
    // [LAW:no-ambient-temporal-coupling] The hydration proof for chatgpt.com,
    // resolved by the wfd.1 spike via live DOM inspection: the spike confirmed
    // chatgpt.com never renders claude.ai's [data-testid="user-message"] (a
    // hard-coded wait there timed out after 20s), and that every message node
    // carries data-message-author-role. Waiting on it proves the conversation
    // hydrated before the scrape read it.
    wait: { kind: "selector", selector: "[data-message-author-role]" },
  },
};

// [LAW:no-ambient-temporal-coupling] The hydration wait for a URL no registered
// provider claims. There is no host-specific selector to wait on (the spike
// proved no universal one exists and a wrong selector times out), so the only
// honest strategy is a bounded settle: give the page a fixed window to render,
// then read whatever is there. 8s sits well under firecrawl's 20s request
// timeout while covering a typical SPA's first paint. This is a deliberate blind
// delay scoped to exactly the case where no proof-of-hydration signal is
// available — paired with parseFallback (parser.ts) as the unclaimed-host plan.
export const FALLBACK_WAIT: WaitStrategy = { kind: "settle", ms: 8000 };

// [LAW:single-enforcer] The one URL→Provider resolution. Iterates PROVIDERS in
// tuple order and returns the first whose pattern matches the trimmed,
// single-line URL; null = no registered provider claims this URL. The trim +
// newline guard lives here so every caller validates a URL identically rather
// than re-deriving the rule. A null result is the caller's branch point:
// ingestPaste turns it into a typed failure today, and the fallback parser
// (slopspot-url-ingestion-wfd.4) will handle unmatched hosts.
export const resolveProvider = (url: string): Provider | null => {
  const trimmed = singleLineUrl(url);
  if (trimmed === null) return null;
  for (const provider of PROVIDERS) {
    if (PROVIDER_REGISTRY[provider].urlPattern.test(trimmed)) return provider;
  }
  return null;
};
