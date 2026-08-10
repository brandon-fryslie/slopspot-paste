import type { Conversation, DraftRecord, Lifetime, PasteVersion } from "./types";
import { isOrigin, isOverlay, isPasteVersion, isPlatform, isTurns, upgradeOrigin, TTL_SECONDS, GRACE_SECONDS, PURGE_BUFFER_SECONDS } from "./types";

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

// [LAW:types-are-the-program] KV is a trust boundary: the stored `overlay` is unknown
// JSON until classified. Absent (the common case — every legacy record and every paste
// with no redactions) normalizes to undefined: zero migration, and deriveViewableDialogue
// reads `overlay ?? []` so undefined renders exactly as captured. A PRESENT-but-invalid
// overlay is dropped to undefined AND logged: in a redaction feature a silently-dropped
// overlay un-redacts, so the drop must be observable [LAW:no-silent-failure] — never a
// silent leak. (Records are written through putConversation with an already-validated
// Overlay, so this only fires on corruption or a hand-edited record.)
const normalizeOverlay = (raw: unknown, slug: string): Conversation["overlay"] => {
  if (raw === undefined) return undefined;
  if (isOverlay(raw)) return raw;
  console.error(`normalizeOverlay: stored overlay failed validation for slug ${slug}, dropping:`, raw);
  return undefined;
};

// [LAW:composability] The injectable slice of the KV binding this module uses —
// declared structurally, NOT the ambient Worker `KVNamespace`, so `env.PASTES`
// assigns as-is while the check scripts (a Node world that deliberately excludes
// the Worker ambient types — see tsconfig.scripts.json) drive the same code
// against a Map-backed stub. The EmbeddingAi move (embeddings.ts) applied to KV:
// the boundary asks for exactly the methods it calls, never the platform's whole
// surface. Each function below narrows further with Pick to just what it reads.
export interface PasteKv {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { readonly prefix: string; readonly cursor?: string }): Promise<{
    readonly keys: ReadonlyArray<{ readonly name: string }>;
    readonly list_complete: boolean;
    readonly cursor?: string;
  }>;
}

const KEY_PREFIX = "paste:";

// [LAW:dataflow-not-control-flow] The stored lifetime decides the KV backstop
// TTL: `expires` arm gets a backstop long enough to survive the active lifetime
// PLUS the full grace window before KV would auto-evict; `pinned` has no TTL
// (lives forever). The backstop is not the expiry mechanism — it is a failsafe
// in case the purge step never runs.
// [LAW:one-source-of-truth] The backstop-TTL policy a stored record derives from
// its paste's lifetime, stated once and shared by the paste record and its version
// archive — so a version can never outlive (or under-live) the paste whose trail it
// is by a drifted second copy of this expression.
const backstopTtl = (lifetime: Lifetime): { readonly expirationTtl: number } | undefined =>
  lifetime.kind === "pinned"
    ? undefined
    : { expirationTtl: TTL_SECONDS + GRACE_SECONDS + PURGE_BUFFER_SECONDS };

export const putConversation = async (
  kv: Pick<PasteKv, "put">,
  c: Conversation,
): Promise<void> => {
  await kv.put(KEY_PREFIX + c.slug, JSON.stringify(c), backstopTtl(c.lifetime));
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
  kv: Pick<PasteKv, "get">,
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
      // [LAW:types-are-the-program] The authored overlay is validated at this read
      // boundary like origin/platformOverride; absence normalizes to undefined so legacy
      // records need no migration, and a corrupt overlay is dropped loudly, never leaked.
      overlay: normalizeOverlay((parsed as { overlay?: unknown }).overlay, slug),
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
export const putDraft = async (kv: Pick<PasteKv, "put">, id: string, draft: DraftRecord): Promise<void> => {
  await kv.put(DRAFT_KEY_PREFIX + id, JSON.stringify(draft), { expirationTtl: DRAFT_TTL_SECONDS });
};

// [LAW:types-are-the-program] KV is a trust boundary even for our own fresh
// writes: a corrupt/absent record reads as null (the editor surfaces "expired or
// not found" loudly) rather than a malformed value poisoning the editor.
// [LAW:single-enforcer] origin normalization reuses the same normalizeOrigin the
// conversation read path uses, so a draft and a published paste lift provenance
// identically.
export const getDraft = async (kv: Pick<PasteKv, "get">, id: string): Promise<DraftRecord | null> => {
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

// [LAW:decomposition] Cached derived projections — the TL;DR summary and the
// semantic vector index — are a SEPARATE concern from published conversations and
// drafts: DISPOSABLE, never authority. Each lives under its own key prefix, keyed
// by slug PLUS a content hash of the exact viewable projection it derives from — so
// a cached value is served only for the reader-visible content it describes, and
// any edit/refetch/overlay change (new hash) simply misses and regenerates.
// [LAW:single-enforcer] All derived-cache reads/writes own their prefix and key
// format here, the way paste:/draft: are owned above; a caller supplies (slug, hash)
// and never assembles the KV key itself.
const SUMMARY_KEY_PREFIX = "summary:";
const VECTOR_INDEX_KEY_PREFIX = "vectors:";

// A generous backstop TTL shared by every derived cache. The hash busts an entry on
// content change, but the generator improves over time with no content change to
// bust it — a better summarizer model, a new embedding model — so the cache
// self-refreshes within this window, letting the improvement be picked up WITHOUT
// baking a model version into the key (which would couple a disposable cache to its
// writer). [LAW:no-ambient-temporal-coupling] It is also what makes the sweep's
// failure path safe: an orphaned entry self-evicts.
const DERIVED_TTL_SECONDS = 30 * 24 * 60 * 60;

const derivedKey = (prefix: string, slug: string, hash: string): string =>
  `${prefix}${slug}:${hash}`;

// [LAW:one-type-per-behavior] The summary cache and the vector-index cache are one
// behavior — best-effort string get/put under <prefix><slug>:<hash>, prefix sweep on
// delete — differing only in prefix. One set of operations, instantiated per prefix
// below, so the "a disposable cache is best-effort, never fatal" invariant is owned
// HERE, once [LAW:single-enforcer]: a transient KV error must not become a Worker
// 500, because a derived value can always be regenerated. This is the deliberate
// OPPOSITE of loadViewablePaste's 503: an AUTHORITY read that fails surfaces loudly
// (it cannot be worked around), but a DISPOSABLE cache read/write that fails is
// worked around by regenerating the exact same value. [LAW:no-silent-failure] no
// error vanishes — every failure is logged.
//
// [LAW:types-are-the-program] KV is a trust boundary, but the cached value is a
// plain string with no schema owned here — a hit is the string, a miss (or transient
// KV error surfaced as absence) is null, and the caller regenerates. A caller whose
// value has internal structure (the vector index) validates it at ITS read boundary;
// the authority is always the paste record, and the value is re-derivable from it.
const getCachedDerived = async (
  kv: Pick<PasteKv, "get">,
  key: string,
): Promise<string | null> => {
  try {
    return await kv.get(key, "text");
  } catch (err) {
    // Surfaced as a cache miss so the caller regenerates the identical value.
    console.error(`derived cache: KV read failed for ${key}:`, err);
    return null;
  }
};

const putCachedDerived = async (
  kv: Pick<PasteKv, "put">,
  key: string,
  value: string,
): Promise<void> => {
  try {
    await kv.put(key, value, { expirationTtl: DERIVED_TTL_SECONDS });
  } catch (err) {
    // The value was already produced and is being returned to the caller; a failed
    // write must not discard it. The write simply doesn't persist — the next request
    // regenerates and re-attempts the cache.
    console.error(`derived cache: KV write failed for ${key}:`, err);
  }
};

// [LAW:one-way-deps] Sweep every cached derivation of a slug under one prefix. A
// derived cache is a projection OF the paste, so when the authority is hard-deleted
// its derivations must go too — otherwise a TL;DR or vector index of deleted content
// lingers until its TTL. Paginated like listConversations because a slug can accrue
// several entries (one per content hash across edits/refetches).
const sweepCachedDerived = async (
  kv: Pick<PasteKv, "list" | "delete">,
  keyPrefix: string,
  slug: string,
): Promise<void> => {
  // [LAW:no-silent-failure] Best-effort, like the other cache ops: a kv.list/kv.delete
  // rejection here must not propagate through deleteConversation (which has already
  // removed the paste) and crash the purge loop for every subsequent record. Log
  // loudly and return — orphaned entries self-evict via DERIVED_TTL_SECONDS anyway.
  try {
    const prefix = `${keyPrefix}${slug}:`;
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, cursor });
      // [LAW:no-silent-failure] allSettled, not all: one failed delete must not abandon
      // the rest of the page (and every later page) — independent deletions proceed and
      // each rejection is logged, so a transient flake orphans at most a few keys (which
      // self-evict via TTL), never an unbounded set.
      const results = await Promise.allSettled(page.keys.map((k) => kv.delete(k.name)));
      for (const r of results) {
        if (r.status === "rejected") {
          console.error(`derived cache: KV delete failed under ${prefix}:`, r.reason);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    console.error(`derived cache: KV list failed under ${keyPrefix}${slug}::`, err);
  }
};

export const getCachedSummary = (
  kv: Pick<PasteKv, "get">,
  slug: string,
  hash: string,
): Promise<string | null> => getCachedDerived(kv, derivedKey(SUMMARY_KEY_PREFIX, slug, hash));

export const putCachedSummary = (
  kv: Pick<PasteKv, "put">,
  slug: string,
  hash: string,
  summary: string,
): Promise<void> => putCachedDerived(kv, derivedKey(SUMMARY_KEY_PREFIX, slug, hash), summary);

export const deleteCachedSummaries = (
  kv: Pick<PasteKv, "list" | "delete">,
  slug: string,
): Promise<void> => sweepCachedDerived(kv, SUMMARY_KEY_PREFIX, slug);

// The vector-index instantiation: the cached value is the JSON of the chunk
// vectors the search service derives (searchService.ts owns that shape and
// validates it on read — KV is a trust boundary, and this layer stores strings).
export const getCachedVectorIndex = (
  kv: Pick<PasteKv, "get">,
  slug: string,
  hash: string,
): Promise<string | null> => getCachedDerived(kv, derivedKey(VECTOR_INDEX_KEY_PREFIX, slug, hash));

export const putCachedVectorIndex = (
  kv: Pick<PasteKv, "put">,
  slug: string,
  hash: string,
  indexJson: string,
): Promise<void> => putCachedDerived(kv, derivedKey(VECTOR_INDEX_KEY_PREFIX, slug, hash), indexJson);

export const deleteCachedVectorIndexes = (
  kv: Pick<PasteKv, "list" | "delete">,
  slug: string,
): Promise<void> => sweepCachedDerived(kv, VECTOR_INDEX_KEY_PREFIX, slug);

// [LAW:decomposition] Version records — archived url-arm snapshots a refetch
// superseded (slopspot-freshness-eck.2) — are a THIRD storage concern, distinct
// from both the authoritative paste record and the disposable derived caches.
// Like the paste, they hold ORIGINAL bytes (the refetch overwrite destroys the
// only other copy, so a version is NOT re-derivable): their writes and deletes
// are LOUD, never the caches' best-effort. Like the caches, they live under
// their own per-slug prefix and die with their paste.
const VERSION_KEY_PREFIX = "version:";

// [LAW:one-source-of-truth] The stored PasteVersion value is the authority; the
// key's zero-padded supersededAt is a derived index that makes kv.list return a
// slug's versions in chronological order (13 digits covers epoch-ms until 2286).
// Two concurrent refetches archiving in the same millisecond collide on the key,
// but each archived the SAME prior record it read, so the overwrite is
// value-identical — the collision cannot lose data.
const versionKey = (slug: string, supersededAt: number): string =>
  `${VERSION_KEY_PREFIX}${slug}:${String(supersededAt).padStart(13, "0")}`;

// [LAW:no-silent-failure] NOT wrapped like the derived-cache puts: the caller
// (the refetch executor) is about to overwrite the only other copy of these
// bytes, so an archive that fails must abort that overwrite — a KV rejection
// propagates loudly instead of being logged into a silent data loss.
export const putPasteVersion = async (
  kv: Pick<PasteKv, "put">,
  slug: string,
  version: PasteVersion,
  lifetime: Lifetime,
): Promise<void> => {
  await kv.put(versionKey(slug, version.supersededAt), JSON.stringify(version), backstopTtl(lifetime));
};

// [LAW:one-source-of-truth] The trail's cheap index: the zero-padded key IS the
// supersededAt stamp, so listing a slug's version instants reads keys only — no
// version bodies (which carry the full archived bytes) are fetched to draw a list
// of dates. Oldest→newest is enforced by the NUMERIC sort below — order derives
// from the stamp value, never from key shape (lexicographic key order matches
// chronology only while every stamp is 13 digits; at the 14-digit rollover the
// two diverge, so key order is a pagination nicety, not the authority).
// [LAW:no-silent-failure] A key whose stamp segment is not a shape versionKey can
// write — all digits, length ≥ 13 (padStart pads short instants to 13 and passes
// longer ones through) — is corruption, dropped loudly, never parsed into a wrong
// instant.
export const listPasteVersionStamps = async (
  kv: Pick<PasteKv, "list">,
  slug: string,
): Promise<ReadonlyArray<number>> => {
  const prefix = `${VERSION_KEY_PREFIX}${slug}:`;
  const out: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const stamp = k.name.slice(prefix.length);
      if (!/^\d{13,}$/.test(stamp)) {
        console.error(`listPasteVersionStamps: malformed version key, dropping: ${k.name}`);
        continue;
      }
      out.push(Number(stamp));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a - b);
};

// [LAW:types-are-the-program] KV is a trust boundary — a stored version record is
// unknown JSON until isPasteVersion classifies it; a corrupt record is dropped
// LOUDLY (an archived original vanishing silently would be the exact failure this
// feature exists to prevent). A missing key is a legitimate absence (expired, or a
// stamp that never was). [LAW:single-enforcer] This is THE version-record read:
// the full listing below routes through it, so the two cannot validate differently.
export const getPasteVersion = async (
  kv: Pick<PasteKv, "get">,
  slug: string,
  supersededAt: number,
): Promise<PasteVersion | null> => {
  const key = versionKey(slug, supersededAt);
  const raw = await kv.get(key, "text");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`getPasteVersion: stored version is not JSON, dropping: ${key}`);
    return null;
  }
  if (!isPasteVersion(parsed)) {
    console.error(`getPasteVersion: stored version failed validation, dropping: ${key}`);
    return null;
  }
  return parsed;
};

// Oldest→newest by construction: the stamp index is chronological and each body
// loads through the one validated read above. A null (expired between list and
// get, or dropped as corrupt — already logged there) is a legitimate absence.
export const listPasteVersions = async (
  kv: Pick<PasteKv, "list" | "get">,
  slug: string,
): Promise<ReadonlyArray<PasteVersion>> => {
  const stamps = await listPasteVersionStamps(kv, slug);
  const batch = await Promise.all(stamps.map((at) => getPasteVersion(kv, slug, at)));
  return batch.filter((v): v is PasteVersion => v !== null);
};

// [LAW:no-silent-failure] LOUD, deliberately unlike sweepCachedDerived: a pinned
// paste's versions carry no TTL backstop, so a swallowed delete failure would
// orphan archived conversation content FOREVER. A rejection propagates to the
// caller (deleteConversation), whose ordering below guarantees a retry path.
export const deletePasteVersions = async (
  kv: Pick<PasteKv, "list" | "delete">,
  slug: string,
): Promise<void> => {
  const prefix = `${VERSION_KEY_PREFIX}${slug}:`;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
};

// Permanently remove a paste record AND its derived caches AND its version
// archive — called only by the purge path after the grace window.
// [LAW:one-way-deps] deleting the authority sweeps its derivations, so a hard
// delete leaves no orphaned summary, vector index, or archived snapshot behind.
// [LAW:no-ambient-temporal-coupling] Versions are swept BEFORE the paste record:
// the purge only revisits slugs whose paste record still exists, so deleting the
// record first would make a mid-sweep failure unreachable by any retry — versions
// of a pinned paste would orphan forever. This order leaves the record standing
// on failure, and the next purge run retries the whole deletion.
export const deleteConversation = async (
  kv: Pick<PasteKv, "list" | "delete">,
  slug: string,
): Promise<void> => {
  await deletePasteVersions(kv, slug);
  await kv.delete(KEY_PREFIX + slug);
  await deleteCachedSummaries(kv, slug);
  await deleteCachedVectorIndexes(kv, slug);
};

// [LAW:decomposition] The draft-prefix counterpart of deleteConversation: revoke a
// handoff draft immediately rather than waiting out DRAFT_TTL_SECONDS. KV delete is
// idempotent (a missing key is a no-op), so this is safe to call for a draft that
// already expired or was never stored — the DELETE endpoint leans on that to stay
// idempotent. [LAW:single-enforcer] all draft writes/reads/deletes own the prefix here.
export const deleteDraft = async (kv: Pick<PasteKv, "delete">, id: string): Promise<void> => {
  await kv.delete(DRAFT_KEY_PREFIX + id);
};

// [LAW:one-source-of-truth] Admin listing derives from the same KV records
// that the read path returns; no parallel index, no stored summary fields.
// [LAW:no-defensive-null-guards] The `c !== null` filter is a real trust
// boundary: a key can expire between `list` and `get`, and a malformed record
// (pre-schema or hand-edited) parses to null. Both are legitimate values to
// drop from the admin view.
export const listConversations = async (
  kv: Pick<PasteKv, "list" | "get">,
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
