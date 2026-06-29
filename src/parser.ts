import type { InputKind, Origin, ParseResult, PasteInput, Provider, Role, TextArmKind, Turn } from "./types";
import { INPUT_KINDS, MAX_PASTE_BYTES, MAX_PASTE_LABEL, TEXT_ARM_KINDS, textArmInput } from "./types";
import { parseClaudeCode } from "./parsers/cc";
import { parseClaudeJsonl } from "./parsers/jsonl";
import { FALLBACK_WAIT, PROVIDER_REGISTRY, resolveProvider } from "./providers";
import { firecrawlScrape, type FirecrawlEnv, type WaitStrategy } from "./firecrawl";

// [LAW:types-are-the-program] Every parser produces the same Turn[] union.
// All variability — which export format, which header style — is absorbed at
// this boundary. Downstream code receives one shape, dispatches on `kind`.
//
// [LAW:dataflow-not-control-flow] Per-kind dispatch is a lookup, not a
// switch — PARSER_BY_KIND maps SourceKind → parser function. `parseInput`
// is two lines: normalize, dispatch. Wrong-kind failure is a clean
// `{ ok: false }` (T2 makes wrong-kind unreachable by gating the dropdown
// with a detector); we don't silently fall back to a different parser
// because that would lie about what the user asked for.

interface HeaderDetector {
  readonly name: string;
  readonly headerPattern: RegExp;
  readonly classify: (label: string) => Role | null;
}

const ROLE_BY_LABEL: ReadonlyMap<string, Role> = new Map([
  ["user", "user"],
  ["you", "user"],
  ["human", "user"],
  ["me", "user"],
  ["assistant", "assistant"],
  ["chatgpt", "assistant"],
  ["gpt", "assistant"],
  ["gpt-4", "assistant"],
  ["gpt-5", "assistant"],
  ["claude", "assistant"],
  ["gemini", "assistant"],
  ["bot", "assistant"],
  ["ai", "assistant"],
  ["model", "assistant"],
  ["system", "system"],
  ["developer", "system"],
]);

const classifyLabel = (raw: string): Role | null => {
  const key = raw.trim().toLowerCase().replace(/[*_`]/g, "");
  if (ROLE_BY_LABEL.has(key)) return ROLE_BY_LABEL.get(key)!;
  // tolerate "GPT-4o", "Claude 3.5 Sonnet", etc. by matching just the leading word
  const leading = key.split(/[\s\-]/)[0] ?? "";
  return ROLE_BY_LABEL.get(leading) ?? null;
};

// [LAW:one-source-of-truth] Each detector is named once, lives once, and is
// referenced by both the legacy auto-race (HEADER_DETECTORS) and the per-kind
// dispatch table below. No copy of the regex anywhere else.
const MARKDOWN_HEADING_DETECTOR: HeaderDetector = {
  // ## User / ## Assistant / ### system  — markdown headings (most explicit)
  name: "markdown-heading",
  headerPattern: /^#{1,6}\s+([A-Za-z][A-Za-z0-9 .\-]{0,40})\s*$/,
  classify: classifyLabel,
};

const SAID_MARKER_DETECTOR: HeaderDetector = {
  // "You said:" / "ChatGPT said:" / "Claude said:" — ChatGPT/Claude copy-paste,
  // AND the heading-prefixed variant a fetched page renders ("#### You said:"):
  // firecrawl emits the speaker label as a markdown heading, so the leading
  // `#{0,6}\s*` tolerates that decoration. Same "Name said:" concept either way —
  // one detector, robust to the rendering variant ([LAW:one-source-of-truth]).
  name: "said-marker",
  headerPattern: /^#{0,6}\s*\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\s+said:?\*{0,2}\s*$/,
  classify: classifyLabel,
};

const NAME_COLON_DETECTOR: HeaderDetector = {
  // "User:" / "Assistant:" / "Human:" — bare name+colon on its own line
  name: "name-colon",
  headerPattern: /^\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\*{0,2}\s*:\s*$/,
  classify: classifyLabel,
};

const trySplitByHeaders = (
  lines: ReadonlyArray<string>,
  detector: HeaderDetector,
): Turn[] | null => {
  const splits: Array<{ role: Role; headerLine: number; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = detector.headerPattern.exec(lines[i]!);
    if (!m) continue;
    const role = detector.classify(m[1]!);
    if (!role) continue;
    splits.push({ role, headerLine: i, start: i + 1 });
  }
  if (splits.length < 2) return null;

  const turns: Turn[] = [];
  for (let i = 0; i < splits.length; i++) {
    const cur = splits[i]!;
    const next = splits[i + 1];
    const end = next ? next.headerLine : lines.length;
    const body = lines
      .slice(cur.start, end)
      .join("\n")
      .replace(/^\s+|\s+$/g, "");
    if (body.length === 0) continue;
    turns.push({ kind: "message", role: cur.role, content: body });
  }
  return turns.length >= 2 ? turns : null;
};

// [LAW:dataflow-not-control-flow] Per-kind parsing is a table lookup. Each
// entry takes normalized text and returns the parser's claim — Turn[] when it
// fits, null when it doesn't. The dispatch in parseInput is two lines.
const parseSingleDetector =
  (detector: HeaderDetector) =>
  (text: string): Turn[] | null =>
    trySplitByHeaders(text.split("\n"), detector);

const parseRaw = (text: string): Turn[] => [
  { kind: "message", role: "assistant", content: text },
];

// Text arms only — claude-share is excluded because it has no synchronous
// (text: string) => Turn[] interpretation; its ingest path is async and
// lives in ingestPaste below. Keeping this table strictly typed prevents a
// future contributor from wiring claude-share into the sync dispatch.
const PARSER_BY_KIND: {
  readonly [K in TextArmKind]: (text: string) => Turn[] | null;
} = {
  "claude-jsonl": parseClaudeJsonl,
  "claude-code": parseClaudeCode,
  "chatgpt": parseSingleDetector(SAID_MARKER_DETECTOR),
  "claude-paste": parseSingleDetector(NAME_COLON_DETECTOR),
  "markdown": parseSingleDetector(MARKDOWN_HEADING_DETECTOR),
  "raw": parseRaw,
};

const normalize = (input: string): string => input.replace(/\r\n?/g, "\n").trim();

// [LAW:one-source-of-truth] The header-detector race lives ONCE here. Iterate
// TEXT_ARM_KINDS most-specific-first (the canonical priority order) and return
// the first parser that claims the text, with the kind it won under. raw is in
// the tuple and total, so the loop always returns; the throw is the loud witness
// [LAW:no-silent-failure] that the raw-is-total invariant held. Both the no-source
// auto path (parseAuto) and the unclaimed-host fallback (parseFallback) are this
// one race — neither re-orders nor re-pairs parsers.
const raceTextArms = (text: string): { kind: TextArmKind; turns: Turn[] } => {
  for (const kind of TEXT_ARM_KINDS) {
    const turns = PARSER_BY_KIND[kind](text);
    if (turns !== null && turns.length > 0) return { kind, turns };
  }
  throw new Error("raceTextArms: no parser matched (raw must always parse)");
};

// [LAW:no-silent-failure] The parser for a fetched page whose host no registered
// provider claims. It runs the same best-effort header race over the fetched
// bytes — a real conversation page (e.g. ChatGPT's "You said:" / "… said:")
// splits into its turns; anything else surfaces as a raw bubble of the fetched
// CONTENT (raw is total). Either way the bytes are projected and shown, never
// silently dropped. This is total, so a url ingest can always render *something*
// honest; only a NAMED provider's parser returning null is a real "couldn't
// extract" failure. Replaying a stored unclaimed-host origin re-runs this exact
// function (via parserFor), so the cache cannot drift from ingest.
export const parseFallback = (markdown: string): Turn[] => raceTextArms(normalize(markdown)).turns;

// [LAW:single-enforcer] The one resolution of "which parser projects this url
// origin's bytes", keyed on the resolved provider (null = unclaimed host →
// fallback). Both ingest and reproject route through it, so a paste is replayed
// through the same parser that first projected it.
const parserFor = (provider: Provider | null): ((markdown: string) => Turn[] | null) =>
  provider === null ? parseFallback : PROVIDER_REGISTRY[provider].parser;

// [LAW:single-enforcer] The companion resolution of "how to wait for this url's
// host to hydrate" — a named provider's selector strategy, or the settle fallback
// for an unclaimed host. Only ingest fetches, so only ingest needs this.
const waitFor = (provider: Provider | null): WaitStrategy =>
  provider === null ? FALLBACK_WAIT : PROVIDER_REGISTRY[provider].wait;

// [LAW:types-are-the-program] parseInput commits to the kind the caller named.
// No silent fallback to a different parser — a wrong pick is a typed failure.
// The T2 detector (detectSources, below) makes wrong picks unreachable from
// the UI by populating the dropdown only with kinds that actually parse.
//
// [LAW:single-enforcer] URL ingestion is genuinely async (Firecrawl fetch).
// Rather than poison this signature with a Promise return for every arm,
// claude-share gets a typed redirect to `ingestPaste`. Callers that want a
// uniform async surface use ingestPaste; callers that only care about text
// arms (parser-check tests, detector) use parseInput.
export const parseInput = (input: PasteInput): ParseResult => {
  if (input.kind === "url") {
    return {
      ok: false,
      reason: "the url arm is fetched, not parsed synchronously; use ingestPaste().",
    };
  }
  // input is narrowed to the content-bearing arms here (the url arm returned
  // above), so no cast is needed — the url-shaped arm cannot reach this point.
  const text = normalize(input.content);
  if (text.length === 0) return { ok: false, reason: "empty input" };
  const turns = PARSER_BY_KIND[input.kind](text);
  if (turns === null || turns.length === 0) {
    return {
      ok: false,
      reason: `Content does not parse as ${input.kind}.`,
    };
  }
  // [LAW:one-source-of-truth] Capture the VERBATIM content the caller supplied,
  // not the normalized text — re-projection re-normalizes when it re-parses, so
  // the stored origin stays byte-identical to the user's input.
  return { ok: true, turns, origin: { kind: input.kind, content: input.content } };
};

// [LAW:single-enforcer] The one entry point that does network I/O for
// PasteInput. Text arms pass straight through to parseInput; the URL arm
// fetches via Firecrawl and parses the returned markdown. The API handler
// uses this so it doesn't branch on `kind` itself — `kind` discrimination
// stays inside the parser module.
export const ingestPaste = async (
  input: PasteInput,
  env: FirecrawlEnv,
): Promise<ParseResult> => {
  if (input.kind !== "url") return parseInput(input);

  // [LAW:dataflow-not-control-flow] Provider resolution is a registry lookup, and
  // a URL no provider claims is NOT a dead end — it resolves to `null`, which
  // selects the fallback wait + parser. So fetch+parse is ONE path for every URL;
  // the provider value only picks which wait strategy hydrates it and which parser
  // projects it. ingestPaste names no provider directly. [LAW:no-silent-failure]:
  // an unclaimed host's bytes are still split into turns (or surfaced as one raw
  // bubble of the fetched content), never dropped — the user's intent that any
  // posted link becomes a conversation, never a lone raw bubble of the link text.
  const provider = resolveProvider(input.url);
  const fetched = await firecrawlScrape(input.url, waitFor(provider), env);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  // [LAW:single-enforcer] The same size cap that the API applies to user input
  // also governs fetched content — otherwise a tiny URL could smuggle an
  // arbitrarily large markdown body past the boundary into parse + KV storage.
  if (new TextEncoder().encode(fetched.markdown).length > MAX_PASTE_BYTES) {
    return { ok: false, reason: `Fetched content exceeds the ${MAX_PASTE_LABEL} limit.` };
  }
  const turns = parserFor(provider)(fetched.markdown);
  if (turns === null || turns.length === 0) {
    // Reachable only for a NAMED provider whose parser rejected the bytes — the
    // fallback is total, so an unclaimed host always yields ≥1 turn above.
    return {
      ok: false,
      reason: "Fetched the page, but could not extract a conversation.",
    };
  }
  // [LAW:one-source-of-truth] The url arm was the lossy one: persist the ORIGINAL
  // fetched markdown alongside the link AND the resolved provider, so re-projection
  // parses these stored bytes through that provider's parser and never has to
  // re-hit the network (a refetch could 404, drift, or cost money — the captured
  // bytes are the authority).
  return {
    ok: true,
    turns,
    origin: { kind: "url", url: input.url, fetched: fetched.markdown, provider },
  };
};

// [LAW:single-enforcer] The ONE "is this a fetchable link" predicate at the input
// boundary: detectSources routes ANY http(s) URL to the fetch arm, and /api/fetch
// re-validates with it (defense against a crafted request that bypassed the UI).
// It recognizes a link, NOT a specific provider — which parser to apply (or the
// fallback) is resolved AFTER fetch via resolveProvider. The trim + single-line
// guard mirrors resolveProvider's, so a string classifies identically at
// detection and at provider resolution. (Lifted from capture-fixture.ts's
// stand-in isHttpUrl, which cited this task as its replacement.)
export const isUrl = (input: string): boolean => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// [LAW:one-source-of-truth] For text arms, the detector IS the parser — it
// calls parseInput and keeps kinds that succeed. There is no separate
// "could-this-parse" heuristic for text arms; drift is structurally impossible.
//
// For the url arm, the detector necessarily diverges: a fetch on every keystroke
// would be wrong (rate-limited, slow, costs money), so a link is recognized by
// isUrl alone and offered as the single generic "url" option — the user does not
// pick a provider, and a lone link never falls through to the text race that
// would render it as a raw bubble of the link text. The actual fetch + provider
// resolution + parse happens at submit time inside ingestPaste. This split is the
// single point where the URL/text asymmetry surfaces; comment it so it doesn't
// metastasize.
//
// [LAW:dataflow-not-control-flow] Empty input is the priming state: no text
// to classify yet, so every input kind is a legitimate pre-selection for the
// about-to-be-pasted content. The return shape (a ReadonlyArray<InputKind>) is
// the same in every case; the dropdown reads it as data and rebuilds its options.
export const detectSources = (input: string): ReadonlyArray<InputKind> => {
  if (normalize(input).length === 0) return INPUT_KINDS;
  // [LAW:no-silent-failure] ANY http(s) link routes to the fetch arm as the sole
  // option; which provider claims it (or that it falls back) is resolved
  // server-side in ingestPaste, not chosen here.
  if (isUrl(input)) return ["url"];
  return TEXT_ARM_KINDS.filter((kind) => parseInput(textArmInput(kind, input)).ok);
};

// [LAW:locality-or-seam] The legacy auto-race lives behind its own seam so
// the API can use it for the no-source path (form posts that pre-date the
// dropdown, direct API callers) without re-introducing race logic into the
// per-kind dispatch above.
//
// [LAW:one-source-of-truth] The race IS an iteration of TEXT_ARM_KINDS over
// PARSER_BY_KIND — priority order and parser pairing both come from the
// canonical tuple in types.ts; there is no second hand-ordered list to drift.
// The winner's kind rides out on the result, so auto-detected pastes carry
// the same provenance as explicitly-picked ones. The raw arm always parses
// (one fallback bubble) and sits last in the tuple, so the loop is total.
export const parseAuto = (input: string): ParseResult => {
  const text = normalize(input);
  if (text.length === 0) return { ok: false, reason: "empty input" };
  // [LAW:one-source-of-truth] The same race the url fallback uses. The origin
  // carries the verbatim input, not the normalized text — the winning kind names
  // how to re-parse it. raceTextArms is total (raw), so a non-empty input always
  // yields a result.
  const { kind, turns } = raceTextArms(text);
  return { ok: true, turns, origin: { kind, content: input } };
};

// [LAW:one-source-of-truth] Re-projection: regenerate Turn[] from a stored
// Origin, PURELY — no network, no side effects. This is the function the
// re-project-in-place child is built on, and the proof that Turns are a derived
// cache: replaying the captured input through today's parser reproduces (or
// improves) the projection.
//
// [LAW:dataflow-not-control-flow] One switch on the discriminator. The url arm
// parses its STORED bytes (never refetches); the text arms re-normalize then
// re-parse; the editor arm returns null because its turns are the source of
// truth — there is no upstream input to replay. A null return means "the stored
// turns ARE canonical", not a failure. The url arm replays through parserFor —
// a named provider's parser, or the best-effort fallback for an unclaimed host
// (origin.provider === null) — so every fetched paste re-derives its stored bytes
// through the same parser that first projected it, which makes replay correct
// (and improvable) for unclaimed hosts as much as for named providers.
export const reprojectOrigin = (origin: Origin): ReadonlyArray<Turn> | null => {
  switch (origin.kind) {
    case "editor":
      return null;
    case "url":
      return parserFor(origin.provider)(origin.fetched);
    default:
      return PARSER_BY_KIND[origin.kind](normalize(origin.content));
  }
};

// [LAW:single-enforcer] The one canonicalization of "turns are the derived cache
// of origin", shared by the create path (POST /api/paste) and in-place
// re-projection (POST /api/reproject) so the two cannot derive different turns
// from the same origin. A replayable origin (text/share) regenerates its turns
// from the captured source via reprojectOrigin — submitted/stored turns are
// ignored, so the cache cannot disagree with the origin it claims to come from.
//
// The editor arm is discriminated by KIND, not by a null reproject result,
// because reprojectOrigin's null is overloaded: it means "no upstream input to
// replay" for editor, but a replayable origin whose stored content reproduces
// nothing (corruption / a hand-edited record) ALSO yields null. Only the editor
// case is "keep the given turns"; the other is failure.
//
// [LAW:no-silent-failure] A replayable origin that reproduces nothing is real
// corruption, surfaced loudly — never a silent fallback to the given turns under
// an origin label that would then lie about replay.
export const canonicalize = (
  turns: ReadonlyArray<Turn>,
  origin: Origin,
): ParseResult => {
  if (origin.kind === "editor") return { ok: true, turns, origin };
  const replayed = reprojectOrigin(origin);
  if (replayed === null || replayed.length === 0) {
    return { ok: false, reason: "Captured origin does not reproduce a conversation." };
  }
  return { ok: true, turns: replayed, origin };
};

// Aliased so imports that pre-date the per-kind API (parser-check tests, any
// in-flight branches) keep compiling. New callers use parseInput / parseAuto.
export const parsePaste = parseAuto;

// [LAW:one-source-of-truth] Title is derived from the first user message
// (or the first message of any role if no user turn exists). Tool calls and
// turn-summary events are skipped — they don't carry conversational content.
export const deriveTitle = (turns: ReadonlyArray<Turn>): string | null => {
  const messages = turns.filter(
    (t): t is Extract<Turn, { kind: "message" }> => t.kind === "message",
  );
  const firstUser = messages.find((t) => t.role === "user") ?? messages[0];
  if (!firstUser) return null;
  const firstLine = firstUser.content.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const stripped = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return stripped.length > 80 ? stripped.slice(0, 77) + "…" : stripped;
};
