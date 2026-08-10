// [LAW:decomposition] The answer→DOM citation projection: split an answer on the
// [t<N>] tag grammar and turn exactly the certified citations into jump links.
// Extracted from the reader page's retrieval script so the page and the check
// (scripts/answer-citations-check.ts) share ONE implementation
// [LAW:one-source-of-truth] — this is the linkify-only-what-was-certified guard,
// and a drifting second copy of it would be a drifting security posture.
//
// [LAW:effects-at-boundaries] Pure given its Document: node creation is the only
// "effect", and the document performing it is a parameter — the page passes the
// real one, the check passes jsdom's — so the projection is testable with no
// global DOM and no browser.

// The slice of a wire citation this projection reads (structurally satisfied by
// the /api/ask citation, which is an OutlineEntry).
export interface CitedTurn {
  readonly index: number;
  readonly anchor: string;
  readonly label: string;
}

// [LAW:types-are-the-program] Everything lands as text nodes except a tag whose
// index appears in `citations` — the set the server already intersected with the
// excerpts the model was shown. An uncited tag (hallucinated, or mangled past
// the grammar) stays plain text: linkification is a lookup in the citation map,
// not trust in the model. Markup in the answer can never become elements — only
// createTextNode and this one anchor shape are ever produced.
export const answerNodes = (
  doc: Document,
  answer: string,
  citations: ReadonlyArray<CitedTurn>,
): Node[] => {
  const byIndex = new Map(citations.map((c) => [c.index, c]));
  return answer.split(/(\[t\d+\])/).map((part) => {
    const tag = /^\[t(\d+)\]$/.exec(part);
    const row = tag ? byIndex.get(Number(tag[1])) : undefined;
    if (!row) return doc.createTextNode(part);
    const link = doc.createElement("a");
    link.className = "ask-cite";
    link.href = "#" + row.anchor;
    link.title = row.label;
    link.textContent = part;
    return link;
  });
};
