// @ts-check
import { execFileSync } from "node:child_process";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// [LAW:effects-at-boundaries] The ONE place the build reads the outside world to learn
// its own provenance. Reading git is an effect; it happens here, at build configuration
// time, and everything downstream receives the answer as a plain value it cannot get
// wrong. src/buildVersion.ts is the typed consumer; nothing else runs git.
//
// [LAW:types-are-the-program] A build's provenance has exactly two legal shapes — the
// commit it was built from, or that commit plus a `-dirty` marker when the tree carried
// uncommitted work. The suffix is what makes the theorem true: a dirty build's version
// string can never be equal to a commit sha, so no verifier can be fooled into calling
// a hand-hacked bundle "commit abc". Cleanliness is not a separate field a caller must
// remember to consult; it is folded into the single value whose equality IS the question.
//
// [LAW:no-silent-failure] execFileSync throws when git is absent or the directory is not
// a checkout, and that throw fails the build. There is deliberately no "unknown" fallback:
// a fallback would be an answer-shaped void — a bundle that reports a plausible-looking
// version while knowing nothing — and the whole point of this value is that production
// can state, truthfully, which commit it is serving.
const gitBuildVersion = () => {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  return git("status", "--porcelain") === "" ? commit : `${commit}-dirty`;
};

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
