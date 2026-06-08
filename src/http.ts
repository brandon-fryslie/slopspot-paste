// [LAW:single-enforcer] Every API route shapes its JSON response the same way,
// here, once. Both /api/paste and /api/fetch emit { ...} | { error } bodies; a
// second copy of this builder would be a second place the content-type or
// serialization could drift.
export const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// [LAW:single-enforcer] Redirect responses are shaped here too. 303 See Other
// makes the browser re-request the target with GET — the correct status after a
// POST so a refresh doesn't re-submit. The no-JS <form> path uses this so a
// JS-disabled user lands on the rendered paste, not a JSON body.
export const seeOther = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location } });
