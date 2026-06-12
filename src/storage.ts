import type { Conversation, Lifetime } from "./types";
import { toStoredOrigin, TTL_SECONDS, GRACE_SECONDS, PURGE_BUFFER_SECONDS } from "./types";

// [LAW:single-enforcer] The deletion lifecycle is now OWNED here, not delegated
// to KV's expirationTtl. The KV backstop TTL is TTL+GRACE+BUFFER — BUFFER
// (7 days) is what gives the purge a real window to run BEFORE KV auto-evicts.
// Without the buffer, isPurgeable and KV fire at the same instant for naturally-
// expired records and KV always wins, making the purge audit log unreachable.
// [LAW:no-silent-failure]: the buffer is what makes the purge's audit record
// the authoritative deletion record rather than silent KV eviction.

// [LAW:one-way-deps] This module imports types only. Pages/API import storage.
// Storage never imports rendering.

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
      // (or hand-edited to junk) read as `absent` — honest absence of a captured
      // source of truth, normalized here so the type above this boundary always
      // sees a StoredOrigin. toStoredOrigin closes the enumeration gap and folds
      // the three historical shapes (wrapper / bare Origin / junk) into one; the
      // backfill child writes `reconstructed` origins for the legacy absent
      // records. The legacy `source` field, if present, is simply dropped:
      // styling is derived from origin now, never from a second stored field.
      origin: toStoredOrigin(parsed.origin),
    } as Conversation;
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
