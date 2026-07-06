// Warn-only turn-scan checks (slopspot-secret-guard-4zw.3). Run: `tsx scripts/secret-warnings-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. secret-check.ts proves the
// pure scanner over a raw string; THIS file proves the warn-only projection over the turns the
// author is about to publish: scanTurnsForSecrets composes that scanner with a Turn's shape and
// reports coarse per-turn {turnIndex, kinds}. The load-bearing claims a warn-BEFORE-publish
// feature rests on [LAW:verifiable-goals]:
//   - a shaped secret in a turn IS flagged, at the right turn index, with the right kind;
//   - a secret hiding in a tool-call's args OR output is flagged (broader than prose-only .4);
//   - a clean turn (and reserved-domain near-miss) produces NO warning;
//   - multiple kinds in one turn dedupe to a stable per-turn label list;
//   - turn indices are reported against the SAME list handed in, across a mix of clean/dirty.
//
// Secret values are synthetic but shaped like the real producers (the same ones secret-check.ts
// uses). None is a live credential.

import { scanTurnsForSecrets } from "../src/secret-warnings";
import type { SecretKind } from "../src/secret-scan";
import type { Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// Shaped-but-synthetic secrets reused across cases.
const AWS = "AKIAIOSFODNN7EXAMPLE";
const OPENAI = "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
const EMAIL = "jane.doe@gmail.com";

const msg = (content: string): Turn => ({ kind: "message", role: "user", content });

console.log("secret-warnings: a shaped secret in a turn is flagged at its turn index + kind");
{
  const turns: Turn[] = [msg("just some clean prose"), msg(`the key is ${OPENAI}`)];
  const warnings = scanTurnsForSecrets(turns);
  assert("exactly one turn is flagged", warnings.length === 1);
  assert("the flagged turn is turn 1 (the second turn)", warnings[0]?.turnIndex === 1);
  assert("the kind is openai-key", warnings[0]?.kinds.includes("openai-key") === true);
  assert("the clean turn 0 is not flagged", warnings.every((w) => w.turnIndex !== 0));
}

console.log("secret-warnings: a secret in a tool-call's ARGS is flagged (non-prose block)");
{
  const turns: Turn[] = [{ kind: "tool-call", tool: "Bash", args: `aws configure set ${AWS}`, output: null }];
  const warnings = scanTurnsForSecrets(turns);
  assert("tool-call args secret is flagged", warnings.length === 1 && warnings[0]?.turnIndex === 0);
  assert("the kind is aws-access-key-id", warnings[0]?.kinds.includes("aws-access-key-id") === true);
}

console.log("secret-warnings: a secret in a tool-call's OUTPUT is flagged");
{
  const turns: Turn[] = [
    { kind: "tool-call", tool: "Bash", args: "cat .env", output: { kind: "terminal", text: `OPENAI_API_KEY=${OPENAI}`, isError: false } },
  ];
  const warnings = scanTurnsForSecrets(turns);
  assert("tool-call output secret is flagged", warnings.length === 1);
  assert("the kind is openai-key", warnings[0]?.kinds.includes("openai-key") === true);
}

console.log("secret-warnings: a hardcoded secret assignment in prose is flagged (assigned-secret)");
{
  // The user-facing payoff of .5: a `key = "value"` credential the structured rules miss is warned
  // at the turn level for free, because scanTurnsForSecrets composes the same scanSecrets.
  const turns: Turn[] = [msg(`the config had api_key = "a1b2c3d4e5f6g7h8i9j0" committed by mistake`)];
  const warnings = scanTurnsForSecrets(turns);
  assert("the assignment turn is flagged", warnings.length === 1 && warnings[0]?.turnIndex === 0);
  assert("the kind is assigned-secret", warnings[0]?.kinds.includes("assigned-secret") === true);
}

console.log("secret-warnings: clean turns and a reserved-domain near-miss produce NO warning");
{
  const turns: Turn[] = [
    msg("a perfectly ordinary message"),
    msg("email the sample user@example.com from the docs"),
    { kind: "thinking", content: "no secrets here, only thoughts" },
    { kind: "tool-call", tool: "Read", args: "src/index.ts", output: { kind: "file-read", text: "export const x = 1;", isError: false } },
  ];
  assert("no turn is flagged", scanTurnsForSecrets(turns).length === 0);
}

console.log("secret-warnings: multiple kinds in one turn dedupe to a stable per-turn list");
{
  const turns: Turn[] = [msg(`contact ${EMAIL} with key ${OPENAI} and again ${EMAIL}`)];
  const warnings = scanTurnsForSecrets(turns);
  assert("the turn is flagged once", warnings.length === 1);
  const kinds = warnings[0]?.kinds ?? [];
  assert("both kinds present", kinds.includes("email") && kinds.includes("openai-key"));
  assert("no duplicate kind despite two emails", new Set(kinds).size === kinds.length);
  // Source order: the email appears before the openai key in the string, so email is first.
  assert("kinds are in source order (email before openai-key)", kinds[0] === "email");
}

console.log("secret-warnings: turn indices are reported against the given list across a mix");
{
  const turns: Turn[] = [
    msg(`leak: ${AWS}`), // 0 — flagged
    msg("clean"), // 1 — not
    { kind: "insight", content: `reach ${EMAIL}` }, // 2 — flagged
    msg("also clean"), // 3 — not
  ];
  const warnings = scanTurnsForSecrets(turns);
  assert("exactly two turns flagged", warnings.length === 2);
  assert("indices are 0 and 2, in order", warnings.map((w) => w.turnIndex).join(",") === "0,2");
  const byIndex = new Map(warnings.map((w) => [w.turnIndex, w.kinds] as const));
  assert("turn 0 is the aws key", byIndex.get(0)?.includes("aws-access-key-id") === true);
  assert("turn 2 is the email", byIndex.get(2)?.includes("email") === true);
}

console.log("secret-warnings: an empty turn list yields no warnings");
{
  const noKinds: ReadonlyArray<SecretKind> = scanTurnsForSecrets([]).flatMap((w) => w.kinds);
  assert("empty list -> no warnings, no kinds", noKinds.length === 0);
}

console.log("secret-warnings complete");
