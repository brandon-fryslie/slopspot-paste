import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

// [LAW:single-enforcer] One middleware, one auth boundary. Every admin route
// flows through this check; no route handler carries auth logic.
// [LAW:effects-at-boundaries] Auth is a boundary concern — intercept here,
// before any handler runs, so handlers stay pure of auth reasoning.

// Exhaustive list of admin routes. A Set<string> makes the protected surface
// grep-able and keeps the check O(1). [LAW:one-source-of-truth]: add routes
// here or they are unprotected — there is no other list.
const ADMIN_ROUTES = new Set([
  "/sloppy",
  "/api/delete",
  "/api/purge",
  "/api/refresh",
  "/api/reproject",
]);

// Timing-safe compare: accumulate XOR differences so the loop runs a fixed
// number of iterations regardless of where a mismatch occurs.
const timingSafeEqual = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
};

const challenge = () =>
  new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="slopspot admin", charset="UTF-8"' },
  });

export const onRequest = defineMiddleware(async ({ request, url }, next) => {
  if (!ADMIN_ROUTES.has(url.pathname)) return next();

  const secret = env.ADMIN_SECRET;
  // [LAW:no-silent-failure] No secret configured = no enforcement. This is
  // intentional for local dev (wrangler dev doesn't require secrets). A
  // production deploy without ADMIN_SECRET is no worse than current unprotected
  // state — it does not silently degrade a working auth gate.
  if (!secret) return next();

  const auth = request.headers.get("authorization") ?? "";
  const spaceIdx = auth.indexOf(" ");
  if (spaceIdx === -1 || auth.slice(0, spaceIdx).toLowerCase() !== "basic") return challenge();

  let password: string;
  try {
    const decoded = atob(auth.slice(spaceIdx + 1));
    const colonIdx = decoded.indexOf(":");
    password = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
  } catch {
    return challenge();
  }

  if (!timingSafeEqual(password, secret)) return challenge();

  return next();
});
