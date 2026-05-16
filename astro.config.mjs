// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// [LAW:one-way-deps] Adapter is the only place the runtime is named.
// [LAW:single-enforcer] Output mode chosen here; routes opt-out via `prerender = true`.
// Note: the adapter auto-provisions a SESSION KV binding whether or not we use
// Astro.session. We create the corresponding KV namespace rather than fight the
// framework; the binding is dormant.
export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  site: "https://paste.slopspot.ai",
});
