// [LAW:decomposition] Spoken notation: which written symbols in a text are read aloud as
// words, and which words. One sentence, no "and": this module finds, in a text, every stretch
// the page writes as notation ("x", "=", "^2", "%") in a context where it is notation, and
// names the words a listener hears for it ("times", "equals", "squared", "percent"). It edits
// no text and keeps no map: the speech script applies what it finds to the characters it
// feeds the model, each spoken character carrying the source span of the symbol it was made
// from (speechScript.ts), so the page and the stored paste never change and the cursor paints
// the symbol while its words are said [LAW:one-source-of-truth] [LAW:one-way-deps].
//
// WHY THE TABLE IS THE WHOLE RULE. Every symbol is one entry — what the page writes, in the
// context it is read in, and what is said for it — and one pass matches every entry at once,
// so a new symbol is a new row, never a new branch [LAW:one-type-per-behavior]
// [LAW:dataflow-not-control-flow]. Rows are tried in table order at each position, so a longer
// spelling ("<=", "^2") is listed before a shorter one it begins with ("<", "^").
//
// WHY THE CONTEXTS ARE NARROW. The same character is notation in "9 x 10" and a letter in
// "x-axis"; a slash is a fraction in "3/4" and not in "I/O", "and/or", a path or a date. A
// symbol read wrongly as a word is worse than one left to the voice, so a binary operator is
// voiced only between two operands: tight between numbers or brackets ("3+4", "(a)*2"), or with a space on each side
// around a number, a single letter or a bracket ("a / b", "x = 5"). Where a tight reading is
// commonly something else it is not taken: "-" between digits is a date or a range, "x"
// between digits is hex, "/" in a run of slashed numbers is a date.

// A text the model is fed has had every whitespace run collapsed to one space, but a context is
// matched on whatever text it is given, so a gap is any whitespace run.
const GAP = String.raw`\s+`;
// A single letter standing alone, as a variable does: not part of a longer word, though it may
// carry a superscript ("b³").
const LETTER = String.raw`(?<![\p{L}\p{N}])[A-Za-z](?![\p{L}\p{Nd}])`;
// What may stand just before a spaced operator — the end of a number, a bracket, a percentage
// or a constant — and just after one: the start of a number (signed), a bracket, a root or a
// constant.
const LEFT = String.raw`(?:[\p{N})\]%°π∞]|${LETTER})`;
const RIGHT = String.raw`(?:[\p{N}(\[√π∞]|[-−]\p{Nd}|${LETTER})`;

// The contexts a symbol is voiced in, as regex source around the symbol's own pattern.
const spaced = (symbol: string): string => String.raw`(?<=${LEFT}${GAP})(?:${symbol})(?=${GAP}${RIGHT})`;
// Tight: against the end of a number or a bracket on the left, the start of one on the right.
const tight = (symbol: string): string => String.raw`(?<=[\p{N})\]])(?:${symbol})(?=[\p{Nd}(\[])`;
// Between two operands, tight or spaced.
const binary = (symbol: string): string => `${spaced(symbol)}|${tight(symbol)}`;
// After an operand, attached to it ("50%", "x²").
const after = (symbol: string): string => String.raw`(?<=[\p{L}\p{N})\]])(?:${symbol})`;
// Before an operand, at the start of a term ("√2", "-5 is").
const before = (symbol: string): string => String.raw`(?<=^|[\s(\[=])(?:${symbol})(?=[\p{N}(\[]|${LETTER})`;

// One row: what the page writes (a regex source, matched with the u flag) and what is said.
export interface Notation {
  readonly written: string;
  readonly said: string;
}

// [LAW:types-are-the-program] Keyed by name so a check can demand a case for every row: a
// row added without one is a type error in the check, not a symbol nobody ever heard.
export const NOTATION = {
  lessOrEqual: { written: binary("<=|≤"), said: "is less than or equal to" },
  greaterOrEqual: { written: binary(">=|≥"), said: "is greater than or equal to" },
  notEqual: { written: binary("!=|≠"), said: "is not equal to" },
  approximately: { written: binary("≈"), said: "is approximately" },
  equals: { written: binary("="), said: "equals" },
  lessThan: { written: binary("<"), said: "is less than" },
  greaterThan: { written: binary(">"), said: "is greater than" },
  plusOrMinus: { written: `${binary("±")}|${before("±")}`, said: "plus or minus" },
  plus: { written: binary(String.raw`\+`), said: "plus" },
  // "-" tight between digits is a date or a range ("2026-09-16", "10-20"), so only spaced; a
  // leading "-" on a number is its sign.
  minus: { written: `${binary("−")}|${spaced("-")}|${before("[-−]")}`, said: "minus" },
  // "×" is only ever multiplication; the letter x is, spaced between two numbers ("9 x 10").
  // Tight between digits it is hex ("0x10"), so never there.
  times: { written: String.raw`${binary("[×*]")}|(?<=\p{Nd}${GAP})x(?=${GAP}\p{Nd})`, said: "times" },
  dividedBy: { written: binary("÷"), said: "divided by" },
  // A slash tight between digits is a fraction ("3/4") unless it is one of a run of slashed
  // numbers, which is a date ("9/16/2026").
  over: { written: String.raw`${spaced("/")}|(?<!\/\p{Nd}+)(?<=\p{Nd})\/(?=\p{Nd}+(?![\p{Nd}\/]))`, said: "over" },
  squared: { written: after(String.raw`\^2(?!\p{N})|²`), said: "squared" },
  cubed: { written: after(String.raw`\^3(?!\p{N})|³`), said: "cubed" },
  toThePowerOf: { written: String.raw`(?<=[\p{L}\p{N})\]])\^(?=[\p{N}(\[]|${LETTER})`, said: "to the power of" },
  percent: { written: String.raw`(?<=\p{Nd})%`, said: "percent" },
  degrees: { written: String.raw`(?<=\p{Nd})°`, said: "degrees" },
  squareRootOf: { written: String.raw`√(?=[\p{N}(\[]|${LETTER})`, said: "the square root of" },
  pi: { written: String.raw`(?<!\p{L})π(?!\p{L})`, said: "pi" },
  infinity: { written: "∞", said: "infinity" },
  half: { written: "½", said: "one half" },
  quarter: { written: "¼", said: "one quarter" },
  threeQuarters: { written: "¾", said: "three quarters" },
} as const satisfies Record<string, Notation>;

export type NotationName = keyof typeof NOTATION;

// One stretch of notation found in a text: its half-open UTF-16 range and the words said for it.
export interface Voiced {
  readonly begin: number;
  readonly end: number;
  readonly said: string;
}

const ROWS: ReadonlyArray<Notation> = Object.values(NOTATION);
// Every row a capture group of one alternation, so one pass finds them all and the group that
// matched names the row.
const PATTERN = new RegExp(ROWS.map((row) => `(${row.written})`).join("|"), "gu");

// The stretches of `text` read aloud as words, in text order and disjoint.
export const voicedNotation = (text: string): ReadonlyArray<Voiced> =>
  Array.from(text.matchAll(PATTERN), (match) => {
    const row = ROWS[match.slice(1).findIndex((group) => group !== undefined)];
    if (row === undefined) throw new Error(`notation match ${JSON.stringify(match[0])} names no row`);
    return { begin: match.index, end: match.index + match[0].length, said: row.said };
  });
