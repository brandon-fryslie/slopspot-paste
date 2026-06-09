// [LAW:single-enforcer] This script is the ONE place the claude-share
// fixture-capture recipe lives: the production scrape (imported, so identical
// by construction — not a copied request shape) plus the credential scrub
// that makes the leak class behind GitHub secret-scanning alert #1
// unrepresentable in committed fixtures. Never commit a raw scrape directly.
//
// Usage:      npm run capture-fixture -- <claude.ai/share URL> <fixture-name>
// Writes:     test/fixtures/<fixture-name>.md
// Exit codes: 0 fixture written · 1 scrape or scrub verification failed ·
//             2 usage / configuration error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firecrawlScrape } from "../src/firecrawl";
import { isClaudeShareUrl } from "../src/parser";
import { isIndicatorEligible, parseClaudeShare } from "../src/parsers/claude-share";
import { MAX_PASTE_BYTES, MAX_PASTE_LABEL } from "../src/types";

// [LAW:dataflow-not-control-flow] The scrub is an unconditional fold over
// rules; a rule with no match is the identity. Each rule mirrors the exact
// produced shape of one AWS SigV4 credential param (the producer's format is
// the spec), and each replacement is chosen for a reason:
//   token  → REDACTED       not length-preserving, so eligibility is verified
//                           downstream rather than assumed;
//   key id → 16 lowercase x scanners require [A-Z0-9]{16} after the prefix,
//                           so lowercase defeats the match and length holds;
//   sig    → 64 zeros       length-preserving, still shaped like a signature.
// The key-id rule matches bare ids anywhere, not just inside
// X-Amz-Credential: secret scanners match bare ids, and over-scrubbing a
// fixture is harmless while under-scrubbing is the failure mode.
// No rule's pattern or replacement can span or introduce a newline — line
// alignment and doubled-pair identity below rely on that.
const TOKEN_END = String.raw`&\s"')\]`;
const SCRUB_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    pattern: new RegExp(String.raw`(X-Amz-Security-Token=)[^${TOKEN_END}]+`, "g"),
    replacement: "$1REDACTED",
  },
  {
    pattern: /(A[KS]IA)[A-Z0-9]{16}/g,
    replacement: "$1" + "x".repeat(16),
  },
  {
    pattern: /(X-Amz-Signature=)[0-9a-fA-F]{64}/g,
    replacement: "$1" + "0".repeat(64),
  },
];

export const scrubCredentials = (markdown: string): string =>
  SCRUB_RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replacement), markdown);

// [LAW:no-silent-failure] Independent of the rules above: these assert the
// OUTPUT state (what a secret scanner would see), so a rule that under-matches
// cannot self-certify. A token value that is not exactly REDACTED, a signature
// value that is not all zeros (including a truncated one the rule skipped), or
// any scanner-matchable key id fails the capture loudly instead of committing.
const LEAK_CHECKS: ReadonlyArray<{ readonly leak: string; readonly pattern: RegExp }> = [
  {
    leak: "AWS access key id (scanner-matchable)",
    pattern: /A[KS]IA[A-Z0-9]{16}/,
  },
  {
    leak: "X-Amz-Security-Token value not REDACTED",
    pattern: new RegExp(String.raw`X-Amz-Security-Token=(?!REDACTED(?:[${TOKEN_END}]|$))`),
  },
  {
    leak: "X-Amz-Signature value not zeroed",
    pattern: new RegExp(String.raw`X-Amz-Signature=(?!0+(?:[${TOKEN_END}]|$))`),
  },
];

export const findCredentialLeaks = (markdown: string): ReadonlyArray<string> =>
  LEAK_CHECKS.filter((c) => c.pattern.test(markdown)).map((c) => c.leak);

// The scrub must preserve each line's structural truth for the parser: a line
// the indicator classifier ignored before scrubbing must still be ignored
// after (and vice versa), or the fixture silently changes meaning. Verified
// with the parser's own predicate. Doubled-pair identity needs no check: the
// scrub is a pure text transform, so identical lines stay identical.
export interface ScrubReport {
  readonly changedLines: number;
  readonly flips: ReadonlyArray<string>;
}

export const compareLines = (before: string, after: string): ScrubReport => {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) {
    throw new Error("scrub changed the line count — a rule spanned or introduced a newline");
  }
  let changedLines = 0;
  const flips: string[] = [];
  a.forEach((orig, i) => {
    const scrubbed = b[i]!;
    if (orig === scrubbed) return;
    changedLines++;
    const was = isIndicatorEligible(orig.trim());
    const now = isIndicatorEligible(scrubbed.trim());
    if (was !== now) {
      flips.push(
        `line ${i + 1}: indicator eligibility flipped ${was} → ${now} ` +
          `(${orig.length} → ${scrubbed.length} chars)`,
      );
    }
  });
  return { changedLines, flips };
};

// Fixture names are enforced here so the convention has a single owner; every
// existing fixture for this source matches it.
const FIXTURE_NAME_RE = /^claude-share(-[a-z0-9-]+)?$/;

function fail(code: 1 | 2, message: string): never {
  console.error(message);
  process.exit(code);
}

// One value, two transports: the env var wins, .dev.vars (the local-dev home
// of the same secret) is read otherwise, and missing both fails loudly naming
// each — never a silent fallback to a different meaning.
const resolveApiKey = (): string => {
  const fromEnv = process.env["FIRECRAWL_API_KEY"];
  if (fromEnv) return fromEnv;
  const devVarsPath = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  const fromDevVars = existsSync(devVarsPath)
    ? readFileSync(devVarsPath, "utf8").match(/^FIRECRAWL_API_KEY=(.+)$/m)?.[1]?.trim()
    : undefined;
  if (fromDevVars) return fromDevVars;
  return fail(2, "FIRECRAWL_API_KEY is not in the environment and not in .dev.vars.");
};

const main = async (): Promise<void> => {
  const [url, name, ...extra] = process.argv.slice(2);
  if (!url || !name || extra.length > 0) {
    fail(
      2,
      "Usage: npm run capture-fixture -- <claude.ai/share URL> <fixture-name>\n" +
        "  fixture-name matches claude-share[-suffix]; output is test/fixtures/<fixture-name>.md",
    );
  }
  if (!isClaudeShareUrl(url)) {
    fail(2, `Not a claude.ai/share URL: ${url}`);
  }
  if (!FIXTURE_NAME_RE.test(name)) {
    fail(2, `Fixture name must match ${FIXTURE_NAME_RE} (got: ${name})`);
  }

  const result = await firecrawlScrape(url, { FIRECRAWL_API_KEY: resolveApiKey() });
  if (!result.ok) {
    fail(1, `Scrape failed: ${result.reason}`);
  }
  // [LAW:types-are-the-program] A fixture is a production-legal input or it is
  // a lie — the same byte cap the ingestion boundary applies governs capture.
  if (new TextEncoder().encode(result.markdown).length > MAX_PASTE_BYTES) {
    fail(1, `Scraped content exceeds the production ${MAX_PASTE_LABEL} limit; not a legal fixture.`);
  }

  const scrubbed = scrubCredentials(result.markdown);
  const leaks = findCredentialLeaks(scrubbed);
  if (leaks.length > 0) {
    fail(1, "Credentials survived the scrub; nothing written:\n" + leaks.map((l) => `  - ${l}`).join("\n"));
  }
  // Mirrors the last ingestion gate: a capture the production parser turns
  // into nothing (e.g. a "Loading..." scrape race) is not a legal fixture.
  const turns = parseClaudeShare(scrubbed);
  if (turns === null || turns.length === 0) {
    fail(1, "Scrape did not parse as a claude.ai share conversation; nothing written.");
  }
  const report = compareLines(result.markdown, scrubbed);
  if (report.flips.length > 0) {
    fail(
      1,
      "Scrub changed parser-visible structure; nothing written:\n" +
        report.flips.map((f) => `  - ${f}`).join("\n"),
    );
  }

  const fixturePath = fileURLToPath(new URL(`../test/fixtures/${name}.md`, import.meta.url));
  writeFileSync(fixturePath, scrubbed);
  console.log(
    `${relative(process.cwd(), fixturePath)} — ${scrubbed.split("\n").length} lines, ` +
      `${report.changedLines} scrubbed`,
  );
};

// Importable (the parser checks exercise the scrub's shape table) and
// runnable; the guard keeps an import from triggering a capture.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
