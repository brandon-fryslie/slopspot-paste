// @ts-check
import { execFileSync } from "node:child_process";

// [LAW:effects-at-boundaries] The ONE place the build reads the outside world to learn its
// own provenance. Reading git is an effect; it happens here, is called once from
// astro.config.mjs, and everything downstream receives the answer as a plain value.
//
// [LAW:types-are-the-program] A build's provenance has exactly two legal shapes — the
// commit it was built from, or that commit plus a `-dirty` marker when the tree carried
// uncommitted work. The suffix is what makes the theorem true: a dirty build's version can
// never be equal to a commit sha, so no verifier can be fooled into calling a hand-hacked
// bundle "commit abc". Cleanliness is not a separate field a caller must remember to
// consult; it is folded into the single value whose equality IS the question.
//
// [LAW:no-silent-failure] execFileSync throws when git is absent or the directory is not a
// checkout, and that throw fails the build. There is deliberately no "unknown" fallback: a
// fallback would be an answer-shaped void — a bundle that reports a plausible-looking
// version while knowing nothing — and the whole point of this value is that production can
// state, truthfully, which commit it is serving.
//
// This lives in its own module rather than inline in astro.config.mjs so the suffix rule is
// exercisable: scripts/deploy-version-check.ts runs it against throwaway repos. Four lines
// of load-bearing logic that nothing can execute in a test is four lines that quietly rot.

/**
 * The commit sha of `cwd`'s checkout, suffixed `-dirty` when the tree is not clean.
 * @param {string} [cwd] directory to inspect; defaults to the current working directory
 * @returns {string}
 */
export const gitBuildVersion = (cwd) => {
  /** @type {(...args: string[]) => string} */
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", cwd }).trim();
  const commit = git("rev-parse", "HEAD");
  return git("status", "--porcelain") === "" ? commit : `${commit}-dirty`;
};
