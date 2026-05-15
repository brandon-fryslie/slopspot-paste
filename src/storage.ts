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

export const getConversation = async (
  kv: KVNamespace,
  slug: string,
): Promise<Conversation | null> => {
  const raw = await kv.get(KEY_PREFIX + slug, "text");
  if (raw === null) return null;
  // Trust boundary: the value came from our own writes. Parse failures here
  // mean storage corruption — surface as null (404) rather than 500.
  try {
    return JSON.parse(raw) as Conversation;
  } catch {
    return null;
  }
};
