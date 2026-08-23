#!/usr/bin/env bash
#
# Assert that the live site is serving a specific commit.
#
# Usage: scripts/verify-live-version.sh <expected-version> [url]
#
# [LAW:decomposition] One job: poll /api/version over the real public hostname until it
# reports the expected commit, or fail loudly at a deadline. It is a separate unit from
# the deploy that precedes it precisely so it can be run alone — after a manual deploy,
# from a laptop, against a preview URL — without dragging a build along.
#
# [LAW:verifiable-goals] `wrangler deploy` exiting 0 proves an upload happened. It does
# not prove that paste.slopspot.ai resolves to the new Worker. This script is the check
# that separates "deployed" from "claimed deployed", and CI runs it every time.
#
# [LAW:no-ambient-temporal-coupling] Propagation takes an unknown, variable amount of
# time, so this waits on the CONDITION (the site reports the expected commit) with a
# bounded deadline — never on a fixed sleep, which is a bet that the deploy was fast
# enough today and turns a real failure into an intermittent one.
set -euo pipefail

expected="${1-}"
if [ -z "$expected" ]; then
  echo "usage: $0 <expected-version> [url]" >&2
  echo "  <expected-version> is a full or abbreviated commit sha (>=7 hex chars)," >&2
  echo "  optionally suffixed '-dirty' to expect a hand-built bundle." >&2
  exit 2
fi
url="${2:-https://paste.slopspot.ai/api/version}"

# [LAW:parse-dont-validate] The argument is parsed into its two domain facts — which commit,
# and whether the tree was clean — before a single request goes out. An unparseable
# expectation is misuse (exit 2) and says so immediately; the alternative, discovered for
# real on 2026-08-23, is polling the full deadline and then blaming a deploy that was
# perfectly healthy. A loud WRONG failure costs as much as a silent one.
case "$expected" in
  *-dirty) expected_sha="${expected%-dirty}"; expected_dirty="-dirty" ;;
  *)       expected_sha="$expected";          expected_dirty="" ;;
esac

if ! [[ "$expected_sha" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: '$expected' is not a commit sha. Expected 7-40 lowercase hex chars," >&2
  echo "optionally suffixed '-dirty'. Nothing was requested; this is a usage error," >&2
  echo "not a deploy failure." >&2
  exit 2
fi

# [LAW:types-are-the-program] The parsed expectation IS the matcher: the live value must be a
# full 40-char sha that begins with the sha we were given and agrees on cleanliness. Deriving
# one regex from the parse — rather than splitting the observed value a second time — means
# there is no second copy of the version grammar to drift, and no separate guard is needed to
# keep '<sha>-dirty' from satisfying '<sha>': the anchored suffix already forbids it.
expected_pattern="^${expected_sha}[0-9a-f]{$(( 40 - ${#expected_sha} ))}${expected_dirty}$"
timeout_seconds="${VERIFY_TIMEOUT_SECONDS:-180}"
poll_interval_seconds=5

deadline=$(( SECONDS + timeout_seconds ))
observed="no successful response yet"

while :; do
  # [LAW:no-silent-failure] A failed request is not swallowed — it becomes the `observed`
  # value, so the deadline message below names what actually happened rather than
  # reporting a generic mismatch. Retrying is correct here (the Worker may not be routable
  # for a second or two); ignoring the outcome would not be.
  if response="$(curl -fsS --max-time 10 "$url")"; then
    observed="$(printf '%s' "$response" | tr -d '[:space:]')"
    if [[ "$observed" =~ $expected_pattern ]]; then
      echo "$url reports $observed — production is serving this commit."
      exit 0
    fi
  else
    observed="request failed (curl exit $?)"
  fi

  remaining=$(( deadline - SECONDS ))
  if [ "$remaining" -le 0 ]; then
    echo "ERROR: $url reports '$observed' after ${timeout_seconds}s; expected '$expected'." >&2
    echo "Production is NOT serving this commit. The deploy did not take effect —" >&2
    echo "investigate before assuming master and paste.slopspot.ai agree." >&2
    exit 1
  fi

  # Never sleep past the deadline: the timeout is a bound the caller set, so a final
  # poll interval that overruns it would make the reported "after Ns" a lie.
  if [ "$remaining" -lt "$poll_interval_seconds" ]; then
    sleep "$remaining"
  else
    sleep "$poll_interval_seconds"
  fi
done
