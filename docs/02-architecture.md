# 02 — System architecture

> Software-first. The only device we build is a simple ESP32 room monitor.
> No paid services anywhere in the stack — see `adr/0004-no-paid-dependencies.md`.

## Service map

```
                        +--------------------------+
                        |      gateway (BFF)       |   authn, rate limits
                        +------------+-------------+
         +--------------+------------+------------+---------------+
         v              v            v            v               v
   +----------+   +----------+  +---------+  +---------+   +---------+
   |  ledger  |   | sealkeys |  | access  |  | render  |   |  trace  |
   | custody  |   | threshold|  | policy  |  | permute |   | leak    |
   | events   |   | + tlock  |  | engine  |  | + mark  |   | decode  |
   +----+-----+   +----+-----+  +----+----+  +----+----+   +----+----+
        |              |             |            |             |
        +--------------+-------------+------------+-------------+
                              |
                    +---------v---------+        +-------------+
                    |     Postgres      |        |   notify    |
                    | append-only, WORM |        | in-app +    |
                    |  role-enforced    |        | webhook     |
                    +-------------------+        +-------------+

Clients: control-room (web) - verify-portal (public) - centre-client (PC)
         field-app (Android) - room-monitor (ESP32)
```

## Services

### `ledger` — custody event store

The spine. Append-only, hash-chained events. Every event carries the signature of
the originating device key and, for handoffs, both parties. The nightly Merkle
root is signed and RFC 3161 timestamped by a free external TSA, then published to
`verify-portal`.

**No UPDATE or DELETE grants exist on the events table.** Enforced at the
database role level, not in application code — an application bug or a
compromised service account must not be able to rewrite history.

### `sealkeys` — sealed package service

Encrypts each centre's bundle. Generates a content key, splits it 3-of-4 by
Shamir, then protects each share differently: one Argon2id passphrase-wrapped for
the authority, one under `tlock` bound to the drand round for exam start, and two
under WebAuthn platform authenticators held by the superintendent and the
independent observer. Never holds a reconstructable key at rest.

### `access` — package access policy engine

> **Implementation note.** The engine exists and is working, but currently lives
> inside `ledger` (`src/domain/policy.ts`, `src/domain/keys.ts`) rather than as a
> separate service. It should be extracted once `gateway` exists to front it.
> Everything below describes what is built.

The QR/NFC tag on a package is an *identifier*, not a key — anyone who
photographs it holds a perfect copy. Nor is identity sufficient on its own: an
attested device held by a rostered person tells you who is asking, not whether
they are meant to be at this stage of custody at this hour.

So each of the eight custody stages carries **its own key, valid for one six-hour
epoch**, expiring by arithmetic on the clock rather than by a scheduled job. If
rotation stops running the system refuses access rather than continuing to grant
it — failure closes. See `adr/0005-custody-keys-expire-by-arithmetic.md`.

Scanning opens an authorisation session; the engine evaluates fifteen checks —
the presented key, Keystore attestation, device-to-centre binding, roster
membership, role-to-stage match, geofence, fix accuracy, custody window, clock
skew, seal-serial match, package and exam state — then returns a signed decision
receipt.

Two rules govern how it records:

- **Every check runs on every request**, never short-circuiting on the first
  failure. An attempt tripping four checks is a materially different event from
  one tripping a clock skew, and there is no second chance to observe an attempt
  that already happened.
- **The attempt is written before the caller is told.** `led.access_attempt` has
  no `UPDATE` or `DELETE` grant, so a refused attempt cannot be removed by anyone.

The record keeps evidence rather than verdicts — `412` metres, not
`outside_geofence` — because a verdict without its inputs cannot be re-examined
years later when the roster and the geofence have both changed.

There is no electronic latch, so the decision is advisory in the physical sense
and binding in the evidentiary sense. Denied attempts are first-class events — a
scan at 02:40 three days early is the highest-value signal the system produces.
An operator who proceeds anyway generates an `OVERRIDE_USED` event that pages the
control room in real time.

### `render` — fingerprinted paper generation

Produces a distinct rendering per centre, and per seat where scoring allows:
block-constrained question and option permutation, a typographic watermark
encoding a copy serial, and an overt margin serial plus QR. Emits the per-copy
answer-key mapping that scoring consumes. The most subtly difficult component in
the system; give it the strongest engineer.

### `trace` — attribution

Takes a leaked image, normalises perspective and contrast, recovers the
permutation signature and watermark, and returns centre, seat range and copy
serial with a confidence score, plus a signed report suitable as an FIR annexure.

### `notify` — alerting

Rule engine over the ledger stream: custody gaps, missed room-monitor heartbeats,
geofence violations, overrides, fallback invocations, print-window overruns.
Paid SMS gateways are out of scope, so escalation is in-app push, webhook, and —
for the crypto fallback path — a control-room operator on the phone.

**No severity grading.** An earlier build labelled entries critical/high/medium
and it was removed deliberately. A severity is one person's judgement compressed
into a word, and it tells an operator how to feel rather than what happened. The
activity ledger instead carries, on every entry: the act, the actor and their
role, the key presented and whether it verified, the position and fix accuracy,
the checks that passed and failed, and the signed payload.

The single judgement the system does make is a boolean `requiresDecision` — a
statement about workflow, not urgency: *this act has consequences nobody has
resolved.* Where it is set, the accompanying text is an instruction lifted from
`07-field-ops-runbook.md` ("stop, do not print, escalate to the authority and the
police"), because that is actionable in a way an adjective is not.

## Clients

| Client | Stack | Notes |
| --- | --- | --- |
| `control-room` | React + Vite + TS, Leaflet + OSM tiles | Live map, alarm queue, dual-auth fallback approvals, evidence export |
| `verify-portal` | Static + TS | Public Merkle root verification, no auth |
| `centre-client` | Go binary, local web UI | Runs on the centre's own Windows PC, binds identity to its existing TPM 2.0 |
| `field-app` | Kotlin | Offline-first custody scanning, Keystore attestation, biometric custodian login |
| `room-monitor` | ESP32-C3 + C | Door, presence, footfall, light. 30-second heartbeat, SD buffer, BLE sync |

## Cross-cutting decisions

- **TypeScript for services.** Small team, one language, and `tlock-js` is
  published by drand. Go for `centre-client` so it ships as one static binary
  onto a school PC with no runtime to install. Kotlin for Android — offline
  reliability, NFC and Keystore attestation matter more than cross-platform reach.
- **Offline-first is a hard requirement, not a feature.** Any client may be
  disconnected for hours. All writes queue locally, are signed at creation time,
  and reconcile on sync. Clock skew is bounded and recorded, never trusted.
- **Not a blockchain.** Hash chain plus external RFC 3161 timestamping plus
  published roots gives tamper-evidence and admissibility without consensus
  overhead — or the procurement scepticism the word attracts.
- **Deny-by-default.** Every access decision, every print, every share release
  starts from refusal and requires positive evidence to proceed.
- **Free-tier only.** Self-hosted Postgres, public drand, free RFC 3161 TSA,
  OpenStreetMap tiles, WebAuthn platform authenticators. No billing anywhere.
