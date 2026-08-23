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
  exit 2
fi
url="${2:-https://paste.slopspot.ai/api/version}"
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
    if [ "$observed" = "$expected" ]; then
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
