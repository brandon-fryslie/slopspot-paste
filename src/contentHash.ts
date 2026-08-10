// [LAW:one-source-of-truth] The ONE content-hash move every derived-projection
// cache keys with: JSON-serialize the exact value the projection consumes, then
// SHA-256 to hex. The summary cache hashes the viewable dialogue its prompt reads
// (dialogueContentHash, summary.ts); the vector index hashes the chunk list it
// embeds (searchService.ts). Both funnel through here, so "hash what you read"
// can never mean two different hash constructions that silently disagree.
//
// Deterministic because its inputs are: both callers hash values produced by pure
// projections over the stored record (deriveViewableDialogue, deriveChunks), so
// the same stored content always yields the same key with no canonicalization
// step — JSON.stringify of a deterministically-constructed value is stable.
export const contentHash = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
