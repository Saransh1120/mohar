# Running this repo

Everything below is installed and working on this machine: Node 24, pnpm,
PostgreSQL 18, the ledger service, a seeded pilot exam, and the control-room UI.

```bash
pnpm install
pnpm build
```

---

## Prerequisites

| What | Version | Notes |
| --- | --- | --- |
| Node.js | 24 LTS | <https://nodejs.org/en/download> |
| pnpm | 9.x | `npm install -g pnpm` (or `corepack enable pnpm`) |
| PostgreSQL | 18 | `winget install PostgreSQL.PostgreSQL.18` on Windows |

Postgres is the only external service. There is no Docker requirement, no cloud
account, and no paid dependency anywhere — see `docs/adr/0004-no-paid-dependencies.md`.

### Database setup

Create the migrator role and the database, then apply migrations:

```bash
psql -U postgres -c "create role mohar_migrator login password 'dev_only_password' createrole"
```

```bash
psql -U postgres -c "create database mohar owner mohar_migrator"
```

```bash
MIGRATE_DATABASE_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar pnpm migrate
```

The migration creates `mohar_app` and `mohar_readonly` itself. Run migrations as
the migrator, never as `mohar_app` — the app role deliberately lacks the
privileges to create or alter the ledger, and that absence *is* the append-only
guarantee.

---

## Running it

Three commands, in three terminals.

**1. The ledger service** (port 8081):

```bash
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  pnpm --filter @mohar/ledger start
```

It refuses to boot if it detects a superuser connection, or any role holding
`UPDATE`/`DELETE` on `led.event`. A `LedgerPrivilegeError` means that check is
working — connect as `mohar_app`.

**2. Seed a pilot exam** (optional, but the UI is empty without it):

```bash
node tools/seed/dist/index.js
```

This enrols ten devices and drives five centres through the real custody
workflow, posting ~43 genuinely Ed25519-signed events through `POST /events`.
Nothing is inserted into `led.event` directly, so if the ledger would reject an
event from a real device it rejects it from the seed tool too.

The five centres cover the paths the control room has to handle:

| Centre | Scenario |
| --- | --- |
| JPR-001 | Clean run, but the content key was never zeroised |
| JPR-002 | 18 hours in transit with nothing recorded |
| JPR-003 | Seal serial mismatch — presumed compromised, never printed |
| JPR-004 | Access denied 16 h early, outside the custody window |
| JPR-005 | Superintendent overrode a denial and printed anyway |

There is deliberately no `--reset`. `led.event.actor_device` is a foreign key
into `ref.device` and nothing may delete from `led.event`, so a device that has
signed an event cannot be removed — and neither can the centre it belongs to.
Each run adds a new exam alongside the previous ones.

**3. The control room** (port 5173):

```bash
pnpm --filter @mohar/control-room dev
```

Open <http://localhost:5173>. It proxies `/api` to the ledger, so the browser
stays same-origin.

### Verifying the cryptography on its own

The Merkle suite has no database dependency:

```bash
pnpm --filter @mohar/crypto-core test
```

Two published RFC 6962 test vectors, 153 inclusion-proof round trips across every
tree size from 1 to 17, and four negative controls that must reject. The expected
roots came from an independent implementation in a different language, so this is
a genuine cross-check rather than the code agreeing with itself.

---

## What exists

| Component | State |
| --- | --- |
| `packages/crypto-core` | Merkle, hash chain, Ed25519 signing, canonical JSON, custody-key derivation. Tested. |
| `packages/contracts` | Zod schemas for every event kind, package lifecycle, deny reasons |
| `services/ledger` | Append path, chain verification, anchoring, device registry, custody projection, **access decision engine**, **rotating custody keys**, activity ledger |
| `apps/control-room` | React + Vite + Leaflet. Overview, packages, custody timelines, activity ledger, key management, devices, integrity |
| `tools/seed` | Key generation, device enrolment, and a custody walkthrough driven through the real engine |

## Custody access keys

Every stage of custody requires its own key, valid for one **six-hour epoch**.

| Property | How it works | Why |
| --- | --- | --- |
| Expiry | `epoch = floor(unixSeconds / 21600)`; a key carries a window and nothing else | Expiry is arithmetic on the clock, not a scheduled job. If rotation never runs, keys stop working rather than keep working — failure closes. |
| Storage | Only SHA-256 of the key is stored; plaintext is returned once at issue | A database dump yields fingerprints, not usable credentials |
| Format | `MHR-<STAGE>-XXXX-XXXX-…`, Crockford base32 (no I, L, O, U) | It has to be readable aloud over a bad phone line at 04:00 without 0/O or 1/l ambiguity |
| Grace | ±30 minutes either side of the boundary | A handoff in progress at the stroke of an epoch must not be stranded |
| Scope | One (package, stage, epoch) | A courier's key cannot open a package; a superintendent's cannot re-route one in transit |

The eight stages are `seal`, `dispatch`, `transit`, `custodian`, `centre`,
`unlock`, `print`, `destroy` — each with the role expected to hold it.

## The access engine

`POST /access/request` is the only way to obtain a decision. It is deny-by-default
and **evaluates every check, always** — never short-circuiting on the first
failure, because an attempt that trips four checks is a materially different
event from one that trips a clock skew, and there is no second chance to observe
an attempt that already happened.

Every attempt is written to `led.access_attempt` **before** the outcome is
returned, and that table has no `UPDATE` or `DELETE` grant. A refused attempt is
the highest-value row in the system; nothing is permitted to prune it.

The record keeps evidence, not verdicts: distance in metres rather than "outside
geofence", the epoch presented against the epoch current rather than "expired".
A verdict without its inputs cannot be re-examined later, and this record has to
stand up as an FIR annexure.

## Why there are no severity labels

The activity ledger deliberately has no critical/high/medium grading. A severity
is one person's opinion compressed into one word, and it tells an operator how to
feel rather than what happened. Each entry instead carries the act, the actor,
the key presented and whether it verified, the position, the checks that passed
and failed, and the signed payload.

The one judgement the system does make is `requiresDecision` — not a severity but
a statement about workflow: this act has consequences nobody has resolved. Where
it applies, the accompanying `consequence` is an instruction drawn from the
field-ops runbook ("stop, do not print, escalate"), because that is actionable in
a way that "critical" is not.

## What does not exist yet

Stated plainly, so the endpoints that do exist do not imply more than they should:

- **Attestation is accepted but never verified.** `POST /devices` stores an
  Android Keystore / TPM chain without checking it against a root of trust, so
  enrolment currently trusts whoever can reach the endpoint. See `adr/0003`.
- **No authentication anywhere.** `gateway` owns authn/authz for the whole system
  and is not built. Nothing here may be exposed beyond localhost. In particular
  `POST /keys/issue` will mint a custody key for anyone who can reach it.
- **Keys are delivered by being displayed.** There is no channel that gets a key
  to a courier's phone; the control room reads it out. That is the intended MVP
  behaviour but it is the weakest link in the key lifecycle.
- **No rate limiting on `/access/request`.** A six-hour window against an
  unthrottled endpoint is a much larger search budget than it should be.
- **No TSA client.** `buildAnchor` computes and stores the daily Merkle root, but
  `led.anchor.tsa_token` is always null — nothing fetches the RFC 3161 token yet.
- **`sealkeys`, `render`, `trace`, `notify`, `gateway`** are README files and
  empty `src` directories. The access engine lives inside `ledger` for now and
  should move to its own service.
- **No integration tests.** The Merkle suite is the only automated test. The
  decision engine is exercised by the seed tool but not asserted on.
- **`verify-portal`, `centre-client`, `field-app`** are unstarted.

The natural next steps are rate limiting on the decision endpoint, real
attestation verification at enrolment, and moving the engine into `services/access`.
