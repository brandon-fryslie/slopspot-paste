import type { Conversation, DraftRecord, Lifetime } from "./types";
import { isOrigin, isPlatform, isTurns, upgradeOrigin, TTL_SECONDS, GRACE_SECONDS, PURGE_BUFFER_SECONDS } from "./types";

// [LAW:single-enforcer] The deletion lifecycle is now OWNED here, not delegated
// to KV's expirationTtl. The KV backstop TTL is TTL+GRACE+BUFFER — BUFFER
// (7 days) is what gives the purge a real window to run BEFORE KV auto-evicts.
// Without the buffer, isPurgeable and KV fire at the same instant for naturally-
// expired records and KV always wins, making the purge audit log unreachable.
// [LAW:no-silent-failure]: the buffer is what makes the purge's audit record
// the authoritative deletion record rather than silent KV eviction.

// [LAW:one-way-deps] This module imports types only. Pages/API import storage.
// Storage never imports rendering.

// [LAW:single-enforcer] The legacy-origin migration lives in types.ts (upgradeOrigin),
// co-located with Origin/isOrigin and shared with the client draft loader — the same
// rename must not be re-implemented per reader. This module composes it with the
// KV-only wrapper unwrap below.

// [LAW:types-are-the-program] KV is a trust boundary. Three historical origin
// shapes exist in the store: bare Origin (current format), the StoredOrigin
// wrapper { status, origin } (written before this commit's simplification), and
// the legacy claude-share discriminator (written before the URL arm was
// generalized). upgradeOrigin lifts the legacy discriminator; isOrigin validates
// the rest. All converge to the same Origin|null the type now declares.
// [LAW:no-silent-failure] Wrapper records are extracted, not silently dropped.
const normalizeOrigin = (raw: unknown): Conversation["origin"] => {
  const upgraded = upgradeOrigin(raw);
  if (isOrigin(upgraded)) return upgraded;
  if (raw && typeof raw === "object") {
    const inner = upgradeOrigin((raw as { origin?: unknown }).origin);
    if (isOrigin(inner)) return inner;
  }
  return null;
};

const KEY_PREFIX = "paste:";

// [LAW:dataflow-not-control-flow] The stored lifetime decides the KV backstop
// TTL: `expires` arm gets a backstop long enough to survive the active lifetime
// PLUS the full grace window before KV would auto-evict; `pinned` has no TTL
// (lives forever). The backstop is not the expiry mechanism — it is a failsafe
// in case the purge step never runs.
export const putConversation = async (
  kv: KVNamespace,
  c: Conversation,
): Promise<void> => {
  const key = KEY_PREFIX + c.slug;
  const body = JSON.stringify(c);
  const options =
    c.lifetime.kind === "pinned"
      ? undefined
      : { expirationTtl: TTL_SECONDS + GRACE_SECONDS + PURGE_BUFFER_SECONDS };
  await kv.put(key, body, options);
};

// [LAW:types-are-the-program] KV is a trust boundary: records were written by
// *some* version of this code. Records written before the Turn discriminated
// union landed have `{ role, content }` (no kind). Normalize on read so the
// type system below this function sees the current shape only.
const normalizeTurn = (t: unknown): unknown => {
  if (t && typeof t === "object" && !("kind" in t) && "role" in t && "content" in t) {
    const old = t as { role: string; content: string };
    return { kind: "message", role: old.role, content: old.content };
  }
  // [LAW:types-are-the-program] Records cached before `isError` landed carry a
  // tool result with no such field. Lift it to `false` (no captured error — the
  // authoritative truth is recoverable by reprojecting the origin), so every
  // ToolOutput above this boundary speaks the current shape. ([LAW:no-silent-
  // failure] absence of a flag is normalized to not-error, never silently
  // treated as a failure.)
  if (
    t && typeof t === "object" && (t as { kind?: unknown }).kind === "tool-call"
  ) {
    const tc = t as { output?: unknown };
    if (tc.output && typeof tc.output === "object" && !("isError" in tc.output)) {
      return { ...t, output: { ...tc.output, isError: false } };
    }
  }
  return t;
};

// [LAW:types-are-the-program] Records written before `lifetime` landed carry a
// bare `expiresAt: number` and no `lifetime`. Lift that flat field into the
// `expires` arm on read, so every record above this boundary speaks the current
// union. A record already on the new shape keeps its lifetime untouched — the
// migration is idempotent.
const normalizeLifetime = (raw: {
  lifetime?: unknown;
  expiresAt?: unknown;
}): Lifetime => {
  if (raw.lifetime && typeof raw.lifetime === "object") {
    return raw.lifetime as Lifetime;
  }
  return { kind: "expires", expiresAt: raw.expiresAt as number };
};

export const getConversation = async (
  kv: KVNamespace,
  slug: string,
): Promise<Conversation | null> => {
  const raw = await kv.get(KEY_PREFIX + slug, "text");
  if (raw === null) return null;
  try {
    // [LAW:one-source-of-truth] Legacy `expiresAt` and `source` are lifted out of
    // the spread and re-derived below (into `lifetime` / `origin`), so a dropped
    // field never lingers on the returned record alongside its replacement.
    const { expiresAt: _legacyExpiresAt, source: _legacySource, ...parsed } = JSON.parse(raw) as Conversation & {
      turns: ReadonlyArray<unknown>;
      expiresAt?: unknown;
      source?: unknown;
      deletedAt?: unknown;
    };
    return {
      ...parsed,
      lifetime: normalizeLifetime({ lifetime: parsed.lifetime, expiresAt: _legacyExpiresAt }),
      // [LAW:types-are-the-program] Records written before deletedAt landed have
      // no such field; normalize to null (live) — absence of a tombstone IS live,
      // never silently treated as deleted. ([LAW:no-silent-failure])
      deletedAt: typeof parsed.deletedAt === "number" ? parsed.deletedAt : null,
      turns: parsed.turns.map(normalizeTurn),
      // [LAW:types-are-the-program] Records written before origin capture landed
      // (or hand-edited to junk) read as null — honest absence. Two historical
      // shapes converge here: a bare Origin (written by this code and later) and
      // a StoredOrigin wrapper { status, origin } (written before this commit).
      // normalizeOrigin unwraps both to Origin|null so no existing record silently
      // loses its captured source. The legacy `source` field is dropped: styling
      // is derived from origin on read. [LAW:no-silent-failure]
      origin: normalizeOrigin(parsed.origin),
      platformOverride: isPlatform(parsed.platformOverride) ? parsed.platformOverride : undefined,
    } as Conversation;
  } catch {
    return null;
  }
};

// [LAW:decomposition] Drafts are a SEPARATE concern from published conversations:
// ephemeral, unlisted, no slug/title/lifetime. They live under their own key
// prefix with a short backstop TTL so an abandoned handoff self-evicts and never
// pollutes the published listing (listConversations only walks `paste:`). A draft
// is the agent-handoff payload the editor restores for review before publishing.
const DRAFT_KEY_PREFIX = "draft:";

// One hour: long enough to extract, open the editor, review and submit; short
// enough that an abandoned draft leaves no lingering trace.
const DRAFT_TTL_SECONDS = 3600;

// [LAW:one-source-of-truth] A draft carries exactly the editable state the editor
// restores — the canonical DraftRecord shape (types.ts), the same one the client
// Draft aliases and the /api/paste editor arm already speak. No second representation.
export const putDraft = async (kv: KVNamespace, id: string, draft: DraftRecord): Promise<void> => {
  await kv.put(DRAFT_KEY_PREFIX + id, JSON.stringify(draft), { expirationTtl: DRAFT_TTL_SECONDS });
};

// [LAW:types-are-the-program] KV is a trust boundary even for our own fresh
// writes: a corrupt/absent record reads as null (the editor surfaces "expired or
// not found" loudly) rather than a malformed value poisoning the editor.
// [LAW:single-enforcer] origin normalization reuses the same normalizeOrigin the
// conversation read path uses, so a draft and a published paste lift provenance
// identically.
export const getDraft = async (kv: KVNamespace, id: string): Promise<DraftRecord | null> => {
  const raw = await kv.get(DRAFT_KEY_PREFIX + id, "text");
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { turns?: unknown; origin?: unknown; platformOverride?: unknown };
    // [LAW:types-are-the-program][LAW:single-enforcer] A valid handoff always has at
    // least one turn — ingestRequest rejects 0-turn pastes on write (ingest-request
    // "Empty paste."), so an empty array here is corruption or a hand-edited record.
    // Reject it (reads back as not-found, surfaced loudly) rather than reopen the
    // editor as a silent blank handoff [LAW:no-silent-failure].
    if (!isTurns(parsed.turns) || parsed.turns.length === 0) return null;
    return {
      turns: parsed.turns,
      origin: normalizeOrigin(parsed.origin),
      platformOverride: isPlatform(parsed.platformOverride) ? parsed.platformOverride : undefined,
    };
  } catch {
    return null;
  }
};

// Permanently remove a KV record — called only by the purge path after the
// grace window. [LAW:no-silent-failure]: callers log what they delete.
export const deleteConversation = async (
  kv: KVNamespace,
  slug: string,
): Promise<void> => {
  await kv.delete(KEY_PREFIX + slug);
};

// [LAW:decomposition] The draft-prefix counterpart of deleteConversation: revoke a
// handoff draft immediately rather than waiting out DRAFT_TTL_SECONDS. KV delete is
// idempotent (a missing key is a no-op), so this is safe to call for a draft that
// already expired or was never stored — the DELETE endpoint leans on that to stay
// idempotent. [LAW:single-enforcer] all draft writes/reads/deletes own the prefix here.
export const deleteDraft = async (kv: KVNamespace, id: string): Promise<void> => {
  await kv.delete(DRAFT_KEY_PREFIX + id);
};

// [LAW:one-source-of-truth] Admin listing derives from the same KV records
// that the read path returns; no parallel index, no stored summary fields.
// [LAW:no-defensive-null-guards] The `c !== null` filter is a real trust
// boundary: a key can expire between `list` and `get`, and a malformed record
// (pre-schema or hand-edited) parses to null. Both are legitimate values to
// drop from the admin view.
export const listConversations = async (
  kv: KVNamespace,
): Promise<ReadonlyArray<Conversation>> => {
  const out: Conversation[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    const batch = await Promise.all(
      page.keys.map((k) => getConversation(kv, k.name.slice(KEY_PREFIX.length))),
    );
    for (const c of batch) {
      if (c !== null) out.push(c);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
};
