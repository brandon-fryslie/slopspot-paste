// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// [LAW:one-way-deps] Adapter is the only place the runtime is named.
// [LAW:single-enforcer] Output mode chosen here; routes opt-out via `prerender = true`.
export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  site: "https://paste.slopspot.ai",
});
