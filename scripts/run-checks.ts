// The one test entry point: discover every scripts/*-check.ts and run them ALL
// CONCURRENTLY, each in its own process. Run: `tsx scripts/run-checks.ts`.
//
// [LAW:one-source-of-truth] The check list is the filesystem, not a hand-copied
// chain in package.json: a new `*-check.ts` is discovered and run with zero
// wiring, so a check can never be written yet silently left out of `npm test`.
//
// Why child processes, not imports into this process: view-check.ts REQUIRES a
// fresh process — jsdom globals must be installed before lit-html's node build
// is first imported (it captures globalThis.document at module-load time), and
// the process boundary is the explicit owner of that initialization order
// [LAW:no-ambient-temporal-coupling]. One shared module graph would trade the
// documented boundary for load-order folklore. Isolation is the contract every
// check was written against; concurrency is where the time goes instead — the
// old `a && b && c` chain serialized 13 independent processes, so the suite
// cost their SUM; running them in parallel costs roughly the slowest one.
//
// [LAW:effects-at-boundaries] Each child's output is buffered whole and printed
// in one deterministic (name-sorted) pass after all complete — interleaved
// live output from 13 concurrent children would be unreadable and unstable.
// [LAW:no-silent-failure] A child that exits non-zero, or dies to a signal,
// fails the suite loudly by name; the runner's exit code is the aggregate.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));

const checks = readdirSync(scriptsDir)
  .filter((f) => f.endsWith("-check.ts") && f !== self)
  .sort();

if (checks.length === 0) {
  console.error("run-checks: no scripts/*-check.ts found — discovery is broken.");
  process.exit(1);
}

interface CheckOutcome {
  readonly file: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

// [LAW:no-silent-failure] The bound on a single check. The slowest real check
// finishes in single-digit seconds; a child still running at this deadline is
// hung (infinite loop, deadlock, unanswered network wait) and is killed and
// reported as a timeout — a loud, named failure instead of an unbounded wait.
const CHECK_DEADLINE_MS = 120_000;

// Children run `node --import tsx <file>` — the same tsx this runner executes
// under — inheriting cwd so fixture paths resolve exactly as they did in the
// package.json chain. Each child announces its start on stderr so a hang is
// attributable from the live terminal even though the report prints at the end.
const runCheck = (file: string): Promise<CheckOutcome> =>
  new Promise((resolve) => {
    console.error(`· starting ${file}`);
    const child = spawn(process.execPath, ["--import", "tsx", join(scriptsDir, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    // [LAW:no-ambient-temporal-coupling] The deadline timer is owned here, armed
    // once per child and disarmed on close; `timedOut` is the one fact the close
    // arm reads to label the kill as a timeout rather than a plain signal death.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHECK_DEADLINE_MS);
    // [LAW:no-silent-failure] A spawn failure fires `error` and never `close`;
    // without this arm the promise would be unresolvable and the suite would hang
    // silently instead of failing this check by name.
    child.on("error", (err) => {
      clearTimeout(deadline);
      resolve({ file, code: 1, signal: null, output: `spawn failed: ${err.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(
        timedOut
          ? {
              file,
              code: 1,
              signal: null,
              output: `${output}\ntimed out after ${CHECK_DEADLINE_MS / 1000}s and was killed\n`,
            }
          : { file, code, signal, output },
      );
    });
  });

const outcomes = await Promise.all(checks.map(runCheck));

for (const { file, code, signal, output } of outcomes) {
  const verdict = code === 0 ? "ok" : signal !== null ? `died: ${signal}` : `exit ${code}`;
  console.log(`\n════ ${file} — ${verdict} ════`);
  process.stdout.write(output);
}

const failed = outcomes.filter((o) => o.code !== 0);
if (failed.length > 0) {
  console.error(`\nrun-checks: ${failed.length} of ${outcomes.length} checks FAILED: ${failed.map((f) => f.file).join(", ")}`);
  process.exit(1);
}
console.log(`\nrun-checks: all ${outcomes.length} checks passed.`);
