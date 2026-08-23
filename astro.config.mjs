// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { gitBuildVersion } from "./scripts/gitBuildVersion.mjs";

// [LAW:one-way-deps] Adapter is the only place the runtime is named.
// [LAW:single-enforcer] Output mode chosen here; routes opt-out via `prerender = true`.
// Note: the adapter auto-provisions a SESSION KV binding whether or not we use
// Astro.session. We create the corresponding KV namespace rather than fight the
// framework; the binding is dormant.
export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  site: "https://paste.slopspot.ai",
  // [LAW:one-source-of-truth] The version is baked into the bundle at build time, so the
  // deployed Worker carries its own provenance rather than anyone remembering what was
  // shipped. Vite substitutes the literal wherever the identifier appears; src/buildVersion.ts
  // is the only module allowed to name it, so the substitution has exactly one seam.
  vite: { define: { __BUILD_VERSION__: JSON.stringify(gitBuildVersion()) } },
});
