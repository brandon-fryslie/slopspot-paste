// Deploy-provenance checks (slopspot-deploy-d2e). Run: `tsx scripts/deploy-version-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. This covers the three
// pieces that let CI say "production is serving this commit" instead of merely claiming a
// deploy happened, and each is here because a silent regression in it would turn the
// verification into a rubber stamp rather than into a visible failure:
//
//   1. gitBuildVersion's `-dirty` suffix — the rule that stops a hand-built bundle from
//      claiming to be a clean commit. Exercised against throwaway git repos, not mocks.
//   2. The /api/version contract — plain text, no-store, body exactly the baked version.
//      Routing it through the shared json() helper would break the verifier's string
//      comparison, and this is what would catch that.
//   3. verify-live-version.sh — run as a real subprocess against a real local server, so
//      its exit codes (and its executable bit) are behaviour under test, not assumptions.
//
// [LAW:behavior-not-structure] Every assertion below is about an observable contract — an
// exit code, a header, a response body — never about how any of the three is implemented.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBuildVersion } from "./gitBuildVersion.mjs";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const scriptsDir = join(fileURLToPath(import.meta.url), "..");
const verifyScript = join(scriptsDir, "verify-live-version.sh");

// ── 1. THE DIRTY SUFFIX: provenance tells the truth about the tree it was built from ──
console.log("\nBuild version derivation (slopspot-deploy-d2e):");
{
  const repo = mkdtempSync(join(tmpdir(), "slopspot-buildversion-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { encoding: "utf8", cwd: repo }).trim();
    git("init", "--quiet");
    git("config", "user.email", "check@example.invalid");
    git("config", "user.name", "check");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "one");

    const head = git("rev-parse", "HEAD");
    const clean = gitBuildVersion(repo);
    assert("clean tree yields exactly HEAD", clean === head);
    assert("clean version carries no suffix", !clean.endsWith("-dirty"));

    writeFileSync(join(repo, "a.txt"), "two\n");
    const modified = gitBuildVersion(repo);
    assert("modified tracked file yields the -dirty suffix", modified === `${head}-dirty`);
    // The whole point of folding cleanliness into the one value: a verifier comparing a
    // live version against a commit sha cannot be fooled by a hand-built bundle.
    assert("a dirty version never equals the clean sha", modified !== head);

    git("checkout", "--", "a.txt");
    assert("reverting the file restores the clean version", gitBuildVersion(repo) === head);

    writeFileSync(join(repo, "untracked.txt"), "new\n");
    assert("an untracked file also counts as dirty", gitBuildVersion(repo) === `${head}-dirty`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // [LAW:no-silent-failure] No provenance is a hard failure, never an "unknown" value:
  // a bundle that reports a plausible-looking version while knowing nothing is exactly
  // the answer-shaped void this whole mechanism exists to avoid.
  const notARepo = mkdtempSync(join(tmpdir(), "slopspot-norepo-"));
  try {
    let threw = false;
    try {
      gitBuildVersion(notARepo);
    } catch {
      threw = true;
    }
    assert("a directory that is not a checkout throws rather than inventing a version", threw);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
}

// ── 2. THE ENDPOINT CONTRACT: what the verifier reads over the wire ──
console.log("\n/api/version response contract (slopspot-deploy-d2e):");
{
  // The build-time substitution Vite performs, supplied here so the module under test can
  // load outside a build. Set before the import: src/buildVersion.ts reads the identifier
  // at module-evaluation time [LAW:no-ambient-temporal-coupling].
  const BAKED = "0123456789abcdef0123456789abcdef01234567";
  (globalThis as Record<string, unknown>)["__BUILD_VERSION__"] = BAKED;

  const { buildVersion } = await import("../src/buildVersion");
  assert("buildVersion is the value baked at build time", buildVersion === BAKED);

  const { GET } = await import("../src/pages/api/version");
  // The handler ignores its context entirely — it reports a compile-time constant and
  // touches no request, env, or binding — so there is nothing for a fixture to supply.
  const response = await GET({} as never);

  assert("status is 200", response.status === 200);
  assert(
    "content type is plain text",
    response.headers.get("content-type") === "text/plain; charset=utf-8",
  );
  // A cached answer would report the previous deploy while the new one is live, and the
  // verifier would believe it.
  assert("cache-control forbids storing the answer", response.headers.get("cache-control") === "no-store");

  const body = await response.text();
  assert("body is exactly the build version plus a newline", body === `${BAKED}\n`);
  // The contract the shell verifier depends on: trimming the body yields the bare sha.
  // Routing this through json() would break here rather than in production.
  assert("trimmed body equals the build version", body.trim() === BAKED);
}

// ── 3. THE VERIFIER: exit codes are its entire contract with CI ──
console.log("\nverify-live-version.sh outcomes (slopspot-deploy-d2e):");
{
  const LIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${LIVE}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/version`;

  // Executed directly, not via `bash …`: that makes the committed executable bit part of
  // what this check covers — losing it would make the CI step fail on permissions alone.
  //
  // Async spawn, never spawnSync: the server answering these requests lives in THIS
  // process, so a synchronous child would block the event loop that has to serve them and
  // every request would time out — the checks would still go green on the exit codes they
  // expect, for entirely the wrong reason [LAW:no-ambient-temporal-coupling].
  const run = (args: string[]): Promise<{ status: number | null; stderr: string; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(verifyScript, args, {
        env: { ...process.env, VERIFY_TIMEOUT_SECONDS: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  try {
    const match = await run([LIVE, url]);
    assert("exits 0 when the live version matches", match.status === 0);
    assert("reports the version it observed", match.stdout.includes(LIVE));

    const mismatch = await run(["b".repeat(40), url]);
    assert("exits 1 when the live version differs", mismatch.status === 1);
    assert("names the version actually observed", mismatch.stderr.includes(LIVE));
    assert("names the version that was expected", mismatch.stderr.includes("b".repeat(40)));

    // [LAW:no-silent-failure] An unreachable site is a distinct failure from a mismatched
    // one, and the message has to say which — a verifier that reports "expected X, got X"
    // when it never reached the host sends the reader looking in the wrong place.
    const unreachable = await run([LIVE, "http://127.0.0.1:1/api/version"]);
    assert("exits 1 when the host is unreachable", unreachable.status === 1);
    assert("names the request failure rather than a bogus mismatch", unreachable.stderr.includes("request failed"));

    const misuse = await run([]);
    assert("exits 2 with usage when no expected version is given", misuse.status === 2);
    assert("usage goes to stderr", misuse.stderr.includes("usage:"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.exitCode) {
  console.error("\nDeploy version checks FAILED.");
} else {
  console.log("\nAll deploy version checks passed.");
}
