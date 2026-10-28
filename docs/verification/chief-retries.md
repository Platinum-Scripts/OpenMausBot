# Chief automatic retry durability

Run only the focused fixture from the repository root, through the factory CPU gate:

```sh
mkdir -p "/tmp/pcc83-$(id -u)"
TMPDIR="/tmp/pcc83-$(id -u)" factory-heavy -- node_modules/.bin/vitest run \
  server/host/chief-retry-durability.e2e.test.ts --maxWorkers=2
```

The fixture starts real HTTP servers with the repository's scripted fake engine,
uses disposable homes, and stops only its own children. A guarded Node import hook
advances the incident/retry clock without changing admission, persistence or engine
execution. The short temporary path avoids UNIX socket path limits. Each journey
prints a retained server log and `.chief-retries.json` evidence file containing
API mutations, source transcripts, delivered notices, journal state and health timings.

Four journeys cover:

1. A failed request, one automatic retry, another failure more than an hour later,
   and a fresh user request. The first request receives exactly one retry; the new
   request gets its own budget. Notice text retains the confirmed retry count.
2. A configured two-retry budget. Both automatic attempts run with their ordinal
   labels before the final failure reaches the Chief, and the journal records two
   reserved and confirmed starts.
3. Restart with a delayed retry pending, then restart with its failure notice
   waiting for Chief capacity. Each dispatch happens once. A further restart
   duplicates neither the retry nor its notice.
4. Restart after retry opt-out, routing change, and user progress. A simulated
   persisted dispatch claim is reported as uncertain, never replayed or described
   as a confirmed start. Corrupt journal state prevents further automatic work.

For the original one-hour regression and a same-fixture health baseline:

```sh
TMPDIR="/tmp/pcc83-$(id -u)" PCC83_BASELINE=1 factory-heavy -- node_modules/.bin/vitest run \
  server/host/chief-retry-durability.e2e.test.ts --maxWorkers=2 -t 'bounds retries'
```

This deliberately loads `b299693a6`'s Chief notice implementation into the isolated
server. It must fail with two retries where one was allowed. It does not edit the
checkout or use another branch's dependencies. Health timings are sequential
loopback samples under one fake-engine workload, not production capacity evidence.

## Durable contract

- `chief-retries/journal.sqlite` under the workspace data directory holds one row
  per thread, using SQLite WAL, FULL synchronization and revision-checked writes.
  The directory is owner-only; the database is mode 0600. It retains identifiers,
  an audience hash, counters and a bounded redacted failure detail, not request or
  reply bodies. Pending work is persisted before a timer is armed.
- A budget boundary is the newest active-path user text message without peer,
  aside, automation or room-request provenance. Its message ID, not the notice
  hour, defines the request. Automatic retries and Chief peer continuations do
  not reset the budget. An absent or regressed boundary fails closed. Existing
  pre-journal retry messages conservatively seed the initial budget.
- Attempts are consumed before dispatch. Confirmed starts and unconfirmed reserved
  attempts are counted separately. No failed/ambiguous dispatch refunds a slot.
- Recovery rechecks the current retry policy, max and delay, bot/task existence, archive status,
  Chief identity, audience, quiet/private routing, assignment, room membership,
  cancellation, newer user messages, successful progress, queue, settling and
  capacity. Busy work stays durably pending and is checked again after five seconds.
- A crash after a retry claim is ambiguous: never replay that claim. Report the
  uncertainty only if the current audience and request still match; further
  automatic retries for that request remain fenced. A crash after a notice claim
  similarly never replays its potentially delivered notice. This is at-most-once
  dispatch, not a promise of exactly-once delivery across external side effects.
- Missing, invalid or unreadable established storage pauses recovery. Errors do
  not reset counts or log failure payloads. Repair/restart is an operator action,
  not an automatic fallback to memory. Old versions' unpersisted timers cannot
  be reconstructed by an upgrade.

No UI changed. These isolated flows do not authorize deployment. Parent integration,
council 3/3 and independent verification remain required.
