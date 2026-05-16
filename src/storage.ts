import type { Conversation } from "./types";
import { TTL_SECONDS } from "./types";

// [LAW:single-enforcer] expirationTtl is the ONLY place 30-day expiry is encoded.
// No cron, no sweeper, no "isExpired" check anywhere else. The storage layer
// removes the key at the deadline; readers see 404 by absence, not by check.

// [LAW:one-way-deps] This module imports types only. Pages/API import storage.
// Storage never imports rendering.

const KEY_PREFIX = "paste:";

export const putConversation = async (
  kv: KVNamespace,
  c: Conversation,
): Promise<void> => {
  await kv.put(KEY_PREFIX + c.slug, JSON.stringify(c), { expirationTtl: TTL_SECONDS });
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

export const getConversation = async (
  kv: KVNamespace,
  slug: string,
): Promise<Conversation | null> => {
  const raw = await kv.get(KEY_PREFIX + slug, "text");
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Conversation & {
      turns: ReadonlyArray<unknown>;
    };
    return { ...parsed, turns: parsed.turns.map(normalizeTurn) } as Conversation;
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
