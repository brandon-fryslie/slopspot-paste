import { parseAuto, ingestPaste, canonicalize } from "./parser";
import { decodeRequest } from "./paste-request";
import type { FirecrawlEnv } from "./firecrawl";
import type { ParseResult, Platform } from "./types";
import { inputText, MAX_PASTE_BYTES, MAX_PASTE_LABEL } from "./types";

// [LAW:single-enforcer] The one ingest contract every content-accepting endpoint
// obeys: decode the wire shape (decodeRequest, pure), enforce the one size cap,
// run the matching parser, enforce turn bounds. /api/paste and /api/draft differ
// ONLY in the tail — publish a permanent conversation vs. store a short-TTL draft
// for review — so the validation and parse that precede that tail live here once.
// Neither endpoint can drift in what bytes it accepts or how it parses them.
// [LAW:one-source-of-truth] The size cap and turn bound have a single home.

export const MAX_TURNS = 10000;

const sizeOf = (s: string): number => new Blob([s]).size;

// [LAW:dataflow-not-control-flow] One value carries the outcome: the validated
// turns+origin (the SUCCESS arm of ParseResult — narrowed here so callers read
// .turns/.origin without re-checking ok) plus the editor's optional platform
// pick, or a typed failure with the HTTP status the caller should emit. The
// caller branches on `ok`, never re-derives "was it too big / empty / unparseable".
type ParsedOk = Extract<ParseResult, { ok: true }>;

export type IngestResult =
  | { readonly ok: true; readonly parsed: ParsedOk; readonly platformOverride?: Platform }
  | { readonly ok: false; readonly status: number; readonly error: string };

export const ingestRequest = async (request: Request, env: FirecrawlEnv): Promise<IngestResult> => {
  const decoded = await decodeRequest(request);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.reason };

  // [LAW:single-enforcer] One size cap, one place. Each arm names the bytes it
  // puts at risk: the user-supplied string for input/legacy, the serialized turns
  // for the editor arm (those bytes ARE the stored payload).
  const rawSize =
    "input" in decoded
      ? sizeOf(inputText(decoded.input))
      : "turns" in decoded
        ? sizeOf(JSON.stringify(decoded.turns))
        : sizeOf(decoded.legacy);
  if (rawSize === 0) return { ok: false, status: 400, error: "Empty paste." };
  if (rawSize > MAX_PASTE_BYTES) {
    return { ok: false, status: 413, error: `Paste exceeds the ${MAX_PASTE_LABEL} limit (${MAX_PASTE_BYTES} bytes).` };
  }

  // [LAW:single-enforcer] Every arm converges to one ParseResult. ingestPaste
  // handles sync text parsing and async URL ingestion; the editor arm runs
  // through canonicalize, which regenerates turns from a replayable origin.
  const parsed: ParseResult =
    "input" in decoded
      ? await ingestPaste(decoded.input, env)
      : "turns" in decoded
        ? canonicalize(decoded.turns, decoded.origin)
        : parseAuto(decoded.legacy);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.reason };
  if (parsed.turns.length === 0) return { ok: false, status: 400, error: "Empty paste." };
  if (parsed.turns.length > MAX_TURNS) {
    return { ok: false, status: 413, error: `Too many turns (max ${MAX_TURNS}).` };
  }

  return { ok: true, parsed, platformOverride: "turns" in decoded ? decoded.platformOverride : undefined };
};
