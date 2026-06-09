import type { Conversation, Lifetime } from "./types";
import { TTL_SECONDS } from "./types";

// [LAW:single-enforcer] KV's expirationTtl is the ONLY mechanism that expires a
// paste. No cron, no sweeper, no "isExpired" check anywhere else. The storage
// layer removes the key at the deadline; readers see 404 by absence, not by
// check. Refresh and pin route back through THIS put — they never add a parallel
// expiry path; they re-state the record's lifetime and let this one enforcer act.

// [LAW:one-way-deps] This module imports types only. Pages/API import storage.
// Storage never imports rendering.

const KEY_PREFIX = "paste:";

// [LAW:dataflow-not-control-flow] The stored lifetime decides the KV call: the
// `expires` arm passes a TTL so KV drops the key at the deadline; the `pinned`
// arm omits it so KV keeps the key forever. Same put, the lifetime value selects
// the option — not a separate "pin" code path. expirationTtl is reset to the
// full TTL_SECONDS on every expires put, which is exactly what "refresh = reset
// the clock" means: re-putting an expires record restarts its countdown.
export const putConversation = async (
  kv: KVNamespace,
  c: Conversation,
): Promise<void> => {
  const key = KEY_PREFIX + c.slug;
  const body = JSON.stringify(c);
  const options =
    c.lifetime.kind === "pinned" ? undefined : { expirationTtl: TTL_SECONDS };
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
    const { expiresAt: _legacyExpiresAt, ...parsed } = JSON.parse(raw) as Conversation & {
      turns: ReadonlyArray<unknown>;
      expiresAt?: unknown;
    };
    return {
      ...parsed,
      lifetime: normalizeLifetime({ lifetime: parsed.lifetime, expiresAt: _legacyExpiresAt }),
      turns: parsed.turns.map(normalizeTurn),
    } as Conversation;
  } catch {
    return null;
  }
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
