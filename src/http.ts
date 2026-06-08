// [LAW:single-enforcer] Every API route shapes its JSON response the same way,
// here, once. Both /api/paste and /api/fetch emit { ...} | { error } bodies; a
// second copy of this builder would be a second place the content-type or
// serialization could drift.
export const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
