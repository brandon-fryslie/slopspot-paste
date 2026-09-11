// Fixture tokenizer for the speech checks. The real SentencePiece model lives in the
// synthesis worker; the invariants the checks assert hold whatever the tokenizer says,
// which is the point of injecting one. One definition, so the checks cannot disagree on
// what a word-ish token is [LAW:one-source-of-truth].

import type { TokenCount } from "../src/speechScript";

export const wordish: TokenCount = (text) => (text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []).length;
