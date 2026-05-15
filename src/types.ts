// [LAW:types-are-the-program] The strongest true theorem about a paste:
// it is an ordered list of role-tagged markdown turns plus identity + lifetime.
// Anonymous + write-once + 30-day expiry means no ownerId, no updatedAt,
// no edit tokens — those fields would permit illegal states.

export type Role = "user" | "assistant" | "system";

export interface Turn {
  readonly role: Role;
  readonly content: string;
}

export interface Conversation {
  readonly slug: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly turns: ReadonlyArray<Turn>;
  readonly title: string | null;
}

// [LAW:single-enforcer] The single enforcer of expiry is KV's expirationTtl.
// This constant is the one place the policy is stated.
export const TTL_DAYS = 30;
export const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// [LAW:types-are-the-program] Discriminated result instead of throws/null
// so callers must structurally handle both outcomes.
export type ParseResult =
  | { ok: true; turns: ReadonlyArray<Turn> }
  | { ok: false; reason: string };
