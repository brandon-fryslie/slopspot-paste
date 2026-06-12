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
  "/api/refetch",
]);

// Timing-safe compare: always runs max(a.length, b.length) iterations.
// Seeding diff with the XOR of the lengths means unequal-length strings produce
// a nonzero diff without an early return — no length oracle via timing.
const timingSafeEqual = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
};

const challenge = () =>
  new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="slopspot admin", charset="UTF-8"' },
  });

// Pre-computed prefix list: ADMIN_ROUTES is a module-level constant so the
// array and concatenation happen once, not on every request.
const ADMIN_PREFIXES = Array.from(ADMIN_ROUTES).map((r) => r + "/");

// Exact match OR sub-path: protects both "/api/delete" and any future
// "/api/delete/<id>" variant. [LAW:single-enforcer]: the check lives here only.
const isAdminPath = (pathname: string): boolean =>
  ADMIN_ROUTES.has(pathname) || ADMIN_PREFIXES.some((p) => pathname.startsWith(p));

export const onRequest = defineMiddleware(async ({ request, url }, next) => {
  if (!isAdminPath(url.pathname)) return next();

  const secret = env.ADMIN_SECRET;
  if (!secret) {
    // [LAW:no-silent-failure] Log when an admin route is reached without a
    // configured secret so the operator can see the misconfiguration. Passthrough
    // is dev-ergonomic (no secret required in local dev) but silence is the
    // defect — once a secret has ever been set, its removal must be observable.
    console.error("[admin-auth] ADMIN_SECRET not configured — admin route unprotected:", url.pathname);
    return next();
  }

  const auth = request.headers.get("authorization") ?? "";
  const spaceIdx = auth.indexOf(" ");
  if (spaceIdx === -1 || auth.slice(0, spaceIdx).toLowerCase() !== "basic") return challenge();

  let password: string;
  try {
    // atob() returns a binary/Latin-1 string; treat each char as a raw byte and
    // decode the resulting buffer as UTF-8 to honor the charset=UTF-8 challenge.
    // RFC 7235 §4.2 permits 1*SP between scheme and token; trim to handle extra spaces.
    const bytes = Uint8Array.from(atob(auth.slice(spaceIdx + 1).trim()), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const colonIdx = decoded.indexOf(":");
    password = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
  } catch {
    return challenge();
  }

  if (!timingSafeEqual(password, secret)) return challenge();

  return next();
});
