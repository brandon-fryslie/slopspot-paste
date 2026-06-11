// [LAW:single-enforcer] The ONE place a legacy paste's origin is reconstructed
// and healed in place. It pairs an existing slug with a recovered claude.ai/share
// URL, re-fetches through the SAME ingestion primitives production uses
// (firecrawlScrape → size cap → parseClaudeShare → canonicalize), and re-stores
// the record under its original slug with a `reconstructed` StoredOrigin — never
// `captured`, because the URL was guessed after the fact and the bytes fetched
// today ([LAW:no-silent-failure]).
//
// Usage:      npm run backfill-origins -- <slug> <claude.ai/share URL>
// Reads:      paste:<slug> from the PASTES KV (production, --remote)
// Writes:     paste:<slug> back, turns re-projected from the fetched bytes,
//             origin = { status: "reconstructed", origin: { claude-share, url, fetched } }
// Exit codes: 0 healed · 1 fetch/parse/verify failed (record untouched) ·
//             2 usage / configuration / KV error.
//
// [LAW:no-silent-failure] The pairing is GATED: the re-fetched conversation must
// match the stored projection (first user message) or the script aborts and
// writes nothing. A wrong URL fetches an unrelated conversation — that must fail
// loudly, never overwrite a paste with someone else's chat.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firecrawlScrape } from "../src/firecrawl";
import { isClaudeShareUrl, canonicalize, deriveTitle } from "../src/parser";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { MAX_PASTE_BYTES, MAX_PASTE_LABEL } from "../src/types";
import type { Conversation, Origin, Turn } from "../src/types";

const PASTES_NAMESPACE_ID = "9e0d7e9ec62e4bf0b46f418356e29a0f";

const fail = (code: 1 | 2, msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(code);
};

// [LAW:effects-at-boundaries] KV access is shelled to wrangler (the one authed
// path), isolated in these two helpers so the transform below stays pure.
const kvGet = (slug: string): string => {
  try {
    return execFileSync(
      "npx",
      ["wrangler", "kv", "key", "get", "--namespace-id", PASTES_NAMESPACE_ID, "--remote", `paste:${slug}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    return fail(2, `KV get failed for paste:${slug} — ${(e as Error).message}`);
  }
};

const kvPut = (slug: string, value: string, expirationSec: number | null): void => {
  const dir = mkdtempSync(join(tmpdir(), "backfill-"));
  const path = join(dir, "value.json");
  writeFileSync(path, value);
  const args = ["wrangler", "kv", "key", "put", "--namespace-id", PASTES_NAMESPACE_ID, "--remote", `paste:${slug}`, "--path", path];
  // [LAW:one-source-of-truth] Preserve the record's existing deadline — backfilling
  // an origin must not silently extend (or reset) a paste's lifetime. KV needs the
  // TTL re-stated on every put, so we re-state the SAME absolute expiry it already had.
  if (expirationSec !== null) args.push("--expiration", String(expirationSec));
  try {
    execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    fail(2, `KV put failed for paste:${slug} — ${(e as Error).message}`);
  }
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// First user message, normalized — shown as a human-readable pairing summary.
const firstUserMessage = (turns: ReadonlyArray<Turn>): string | null => {
  const m = turns.find((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message" && t.role === "user");
  return m ? norm(m.content) : null;
};

// [LAW:no-silent-failure] The pairing fingerprint: the LONGEST stored user message,
// normalized. A long, specific user utterance ("In the 306th payment -> I paid
// 2395 for 1305.18 loan…") is effectively unique to one conversation, so requiring
// it to appear verbatim in the re-fetched page makes a false-accept (writing an
// unrelated chat over this paste) essentially impossible — far stronger than a
// short first-line prefix like "correct this code.".
const fingerprint = (turns: ReadonlyArray<Turn>): string | null => {
  const userMsgs = turns
    .filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message" && t.role === "user")
    .map((t) => norm(t.content))
    .filter((s) => s.length >= 20)
    .sort((a, b) => b.length - a.length);
  return userMsgs[0] ?? null;
};

const main = async (): Promise<void> => {
  const [slug, url] = process.argv.slice(2);
  if (!slug || !url) fail(2, "Usage: npm run backfill-origins -- <slug> <claude.ai/share URL>");
  if (!isClaudeShareUrl(url)) fail(2, `Not a valid claude.ai/share URL: ${url}`);

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) fail(2, "FIRECRAWL_API_KEY not set (export it from .dev.vars before running).");

  // --- read the existing record (the heal target) ---
  const rawExisting = kvGet(slug);
  if (rawExisting.trim().length === 0) fail(2, `No record at paste:${slug} (expired or wrong slug?).`);
  const existing = JSON.parse(rawExisting) as Conversation & { turns: Turn[]; expiresAt?: number; lifetime?: { kind: string; expiresAt?: number } };
  const storedFingerprint = fingerprint(existing.turns);
  if (storedFingerprint === null) fail(1, "Stored paste has no user message long enough to fingerprint — cannot verify a pairing.");

  // --- re-fetch through the production ingestion primitives ---
  console.log(`→ fetching ${url} …`);
  const fetched = await firecrawlScrape(url, { FIRECRAWL_API_KEY: apiKey });
  if (!fetched.ok) fail(1, `Firecrawl fetch failed: ${fetched.reason}`);
  if (new TextEncoder().encode(fetched.markdown).length > MAX_PASTE_BYTES) {
    fail(1, `Fetched content exceeds the ${MAX_PASTE_LABEL} limit.`);
  }
  const newTurns = parseClaudeShare(fetched.markdown);
  if (newTurns === null || newTurns.length === 0) {
    fail(1, "Fetched the page, but could not extract a conversation (degenerate/Loading page?).");
  }

  // --- VERIFY the pairing before touching the record ---
  // [LAW:no-silent-failure] The fetched page must contain the paste's distinctive
  // stored user message verbatim, or this is not its source — abort, write nothing.
  console.log(`  stored fetched first msg: ${firstUserMessage(newTurns!)?.slice(0, 70) ?? "(none)"}`);
  console.log(`  fingerprint sought:       ${storedFingerprint.slice(0, 70)}…`);
  if (!norm(fetched.markdown).includes(storedFingerprint)) {
    fail(1, `Pairing REJECTED — the paste's distinctive message is absent from this page. Not this paste's source.`);
  }
  console.log(`  ✓ pairing verified (turns ${existing.turns.length} → ${newTurns!.length})`);

  // --- build the reconstructed record (pure transform) ---
  const origin: Origin = { kind: "claude-share", url, fetched: fetched.markdown };
  const reprojected = canonicalize(existing.turns, origin);
  // [LAW:no-silent-failure] Past this guard, `fail`'s `never` return narrows
  // reprojected to the ok-variant — the turns below are the replayed ones, never a
  // silent fallback to the stored cache under a reconstructed label.
  if (!reprojected.ok) return fail(1, `canonicalize failed: ${reprojected.reason}`);

  // [LAW:one-source-of-truth] Replace only the derived values (turns + title) and
  // stamp the reconstructed origin. slug, createdAt, lifetime are preserved.
  const { expiresAt: _legacyExpiresAt, source: _legacySource, ...rest } = existing as Record<string, unknown>;
  const healed = {
    ...rest,
    turns: reprojected.turns,
    title: deriveTitle(reprojected.turns),
    origin: { status: "reconstructed" as const, origin },
  };

  // Preserve the absolute expiry KV already enforced (ms → s). Legacy records
  // carry the deadline either in lifetime.expires or a bare expiresAt.
  const deadlineMs =
    existing.lifetime?.kind === "expires" ? existing.lifetime.expiresAt : existing.expiresAt;
  const expirationSec = typeof deadlineMs === "number" ? Math.floor(deadlineMs / 1000) : null;

  kvPut(slug, JSON.stringify(healed), expirationSec);
  console.log(`✓ healed paste:${slug} — reconstructed claude-share origin stored, turns re-projected.`);
};

void main();
