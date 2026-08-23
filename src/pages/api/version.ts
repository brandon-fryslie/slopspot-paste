import type { APIRoute } from "astro";
import { buildVersion } from "../../buildVersion";

export const prerender = false;

// [LAW:decomposition] This route has one job: let anyone outside the deploy ask the
// running site which commit it is. That question used to be unanswerable — "what is
// deployed" lived only in someone's memory, and the site drifted two weeks behind master
// without anything noticing (slopspot-deploy-d2e). With the bundle stating its own
// provenance, "is production master?" stops being an inference and becomes a comparison.
//
// [LAW:verifiable-goals] This is what makes a deploy checkable rather than merely claimed.
// `wrangler deploy` exiting 0 says the upload succeeded; it does not say the custom domain
// is serving the new Worker. scripts/verify-live-version.sh polls THIS endpoint, over the
// real public hostname, until it reports the commit CI just built — evidence, not a promise.
//
// Plain text, not the shared json() builder: the resource is a single scalar whose whole
// contract is `test "$(curl …)" = "$sha"`. A JSON envelope would add a parse step to every
// consumer — the verifier, a monitoring probe, a human with curl — to wrap one string.
export const GET: APIRoute = () =>
  new Response(`${buildVersion}\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // [LAW:no-silent-failure] A cached answer here is a lie with a plausible shape: it
      // would report the previous deploy while the new one is live (or vice versa) and the
      // verifier would trust it. `no-store` states the requirement instead of relying on
      // an intermediary's default caching behaviour happening to be convenient today.
      "cache-control": "no-store",
    },
  });
