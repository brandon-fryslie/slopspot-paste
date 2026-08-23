// [LAW:one-source-of-truth] The single authoritative answer to "which commit is this
// bundle". astro.config.mjs derives it from git once, at build time, and Vite substitutes
// the literal here. No other module may name `__BUILD_VERSION__`: this file is the one
// seam between the untyped build-time substitution and typed application code, so the
// deployed provenance has exactly one home, one type, and one spelling.
//
// [LAW:one-way-deps] Nothing in the app depends on this except the endpoint that reports
// it. Behaviour must never branch on the build version — a bundle that acts differently
// depending on which commit produced it would be [LAW:no-ambient-temporal-coupling] in
// its purest form. This value is for telling the truth about the deploy, nothing else.
declare const __BUILD_VERSION__: string;

// The commit sha this bundle was built from, suffixed `-dirty` when the build tree had
// uncommitted changes. See astro.config.mjs for why the two states share one string:
// equality against a commit sha is the entire question this value exists to answer, and
// a dirty build must be structurally incapable of answering it "yes".
export const buildVersion: string = __BUILD_VERSION__;
