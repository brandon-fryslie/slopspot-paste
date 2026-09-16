// [LAW:decomposition] CommonMark's fenced-code-block rules, as two questions about a line:
// which fence does it open, and does it close this one. The one authority every reader of
// markdown that must keep a fence whole asks [LAW:one-source-of-truth] — the speech
// segmenter (speech.ts) announces a fence instead of reading it, the digest input
// (turnDigest.ts) keeps it one paragraph — so the two can never disagree about where a
// block ends.
//
// [LAW:types-are-the-program] A Fence carries the delimiter run itself, not just that one
// was present, because the closing rule needs it: a close must reuse the SAME character as
// its opener and be at least as long. Without that, a block opened with ``` that discusses
// fence syntax and contains a nested ~~~ example — or a shorter ``` — would close on the
// wrong line. And a close carries no info string ("may be followed only by spaces or
// tabs"), so a nested opener of the same char and length (```md holding a ```js example)
// is not mistaken for the outer close.
//
// The info string is captured WHOLE, not as a bare language token: a real opener can carry
// more (```jsx twoslash, ```js {1,3}), and requiring nothing after the language would fail
// to see those as fences at all, spilling the block's own backticks into prose.
export interface Fence {
  readonly char: string;
  readonly length: number;
  readonly info: string;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/;

// The fence this line opens, or null when it opens none.
export const opensFence = (line: string): Fence | null => {
  const fenced = FENCE.exec(line);
  return fenced === null ? null : { char: fenced[1]![0]!, length: fenced[1]!.length, info: fenced[2]!.trim() };
};

// Whether this line closes the open fence: the same character, at least as long, no info.
export const closesFence = (line: string, open: Fence): boolean => {
  const fenced = opensFence(line);
  return fenced !== null && fenced.char === open.char && fenced.length >= open.length && fenced.info === "";
};
