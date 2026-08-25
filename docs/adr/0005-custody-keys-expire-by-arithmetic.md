# ADR 0005 — Custody keys expire by arithmetic, not by a scheduled job

**Status:** accepted
**Supersedes:** nothing. Extends `05-unlock-protocol.md`.

## Context

Until this decision, an access request carried *identity* — an attested device and
a rostered person — and nothing else. That answers "who is asking" but not "is
this person supposed to be at this stage of this package's custody, right now".

Those are different questions, and the second is the one the Hazaribagh-class
failure turns on. The trunk was opened by people who had the keys and who were
entitled to be near it. Identity checks pass cleanly in exactly that scenario.

We needed a credential that is scoped to a moment and a role, so that possessing
it says something time-bounded rather than permanent.

## Decision

Every custody stage of every package carries its own key, valid for one six-hour
**epoch**, where `epoch = floor(unix_seconds / 21600)`.

Four properties, each load-bearing:

1. **Expiry is derived from the clock, not scheduled.** A key's validity window is
   computed from its epoch number. No job marks keys expired.

2. **The key is never stored.** We keep SHA-256 and a fingerprint. The holder sees
   the plaintext once, at issue.

3. **Scope is (package, stage, epoch).** One live key per stage per epoch, enforced
   by a unique constraint.

4. **A ±30 minute grace surrounds each boundary.** A key is accepted slightly
   before its epoch opens and slightly after it closes.

## Why these, specifically

### Expiry as arithmetic

The alternative — a cron job that marks keys expired — has a failure mode we
consider unacceptable: if the job stops running, every key silently remains valid.
That failure is invisible, because the system continues granting access exactly as
it did the day before. Nobody notices until an investigation asks why a key from
three weeks ago still worked.

Deriving the window from the epoch inverts the failure. If rotation never runs, no
key exists for the current epoch and access is **refused**. The system fails
closed, and it fails loudly — refusals appear immediately in the activity ledger.

We would rather explain a refusal than discover a credential that outlived its
purpose.

### Hashing rather than storing

Identical reasoning to password storage, and for once the analogy is exact: we
need to verify a presentation, never to reproduce the secret. Storing the key
would mean a database dump — or a backup, or a replica, or a support engineer's
query — yields working credentials for every package in the system.

The cost is that a lost key is unrecoverable. We accept it. Rotating to the next
epoch is a six-hour inconvenience; a recoverable credential is a permanent
liability.

### Scoping to a stage

Without stage scoping, one key per package would mean a courier's credential could
open the package on arrival. The eight stages exist so that holding a key answers
"authorised to do *this*", not "authorised generally".

### The grace window

A handoff is a human operation involving two people, a seal, a photograph and a
key read aloud. Beginning one at 05:58 and having it refused at 06:00 would be a
refusal caused by our arithmetic rather than by anything wrong.

Thirty minutes is enough to finish an operation in progress and short enough that
it cannot be used as a second key. It is a deliberate, bounded softening of a hard
edge, and it is recorded here so nobody later "tidies it away" as an oversight.

## Consequences

**Accepted:**

- A key photographed at 02:00 is worthless by 06:30. The window for a copied
  credential is bounded by construction rather than by policy.
- Key-related refusals are distinguishable from each other. "Never issued" and
  "three epochs stale" call for completely different responses — find out who
  made it, versus find the holder and re-issue — and the engine reports which.
- The system fails closed if rotation stops.

**Costs, stated plainly:**

- **Distribution is unsolved.** There is no channel that gets a key to a courier's
  phone. Today the control room reads it out. This is the weakest link in the key
  lifecycle and it is not addressed by this decision.
- **Six hours is a long search window against an unthrottled endpoint.** 128 bits
  makes brute force infeasible, but `/access/request` has no rate limiting yet,
  and it should before this is deployed anywhere real.
- **Operational load.** Eight keys per package per six hours is a lot of issuance
  at state scale. The pilot is 20–50 centres; this needs revisiting well before it
  is 5,000.
- Losing a key costs up to six hours of waiting, or a manual re-issue by someone
  with control-room access — which is itself a path worth auditing.

## Alternatives considered

**Derive keys from a master secret via HKDF.** Would remove storage entirely and
allow any authorised party to recompute a key. Rejected: compromise of the master
compromises every key that ever existed or will exist, and there is no revocation
short of re-keying the entire system.

**Long-lived keys with explicit revocation.** Simpler operationally. Rejected
because it depends on someone *noticing* that a key needs revoking. The entire
point is to bound exposure from a compromise nobody has detected yet.

**WebAuthn assertions instead of keys.** Already used for share custody
(`03-crypto-design.md`) and stronger where it applies. Rejected here because it
requires the holder's registered authenticator to be present and working. A
courier on a road with a dead phone still has to hand over a package, and a
credential that cannot be read aloud does not survive that.
