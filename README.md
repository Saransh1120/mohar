# Mohar — Sealed Examination Paper Custody Chain

A tamper-evident, time-locked custody and distribution system for competitive and
government examination papers.

**Design goals** (see `docs/00-overview.md` for why these and not "a paper that can never leak"):

1. Collapse the **exposure window** — the time a paper exists in readable form —
   from ~240 hours to under one hour.
2. Make every leak **attributable** to a centre, and where possible a seat,
   within minutes of an image surfacing.
3. Produce a **custody record investigators can work from**, because India's
   exam-fraud problem is an evidentiary failure (148 cases since 2015, one
   conviction) more than a detection failure. Whether the record is accepted
   as evidence in court has not been checked by a lawyer and is not claimed.

**Non-goal:** eliminating leaks entirely. A paper must be readable by humans at
several points in its life. We shrink and instrument those points; we do not
pretend to remove them.

## Repository layout

| Path | What lives here |
| --- | --- |
| `docs/` | Architecture, threat model, crypto design, data model, runbooks |
| `services/` | Backend services (TypeScript / Fastify / Postgres) |
| `apps/` | Control room (with the public `/verify` page) and the courier field app |
| `packages/` | Shared contracts, crypto primitives, ledger client, UI kit |
| `firmware/` | ESP32 sketches: room monitor, witness station, seal lock |
| `infra/` | Docker compose, SQL migrations, Terraform, attestation roots |
| `tools/` | Seed data, label printing and sealing, device provisioning, end-to-end checks |
| `tests/` | End-to-end, load, and shared fixtures |

## Quick start

Needs Node 24, pnpm, and PostgreSQL 18. Full setup in [RUNNING.md](RUNNING.md).

```bash
pnpm install
pnpm build
MIGRATE_DATABASE_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar pnpm migrate

# terminal 1 — the gateway on :8081, with the ledger and access engine behind it on loopback
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  pnpm start

# terminal 2 — seed a pilot exam (optional; the UI is empty without it)
node tools/seed/dist/index.js

# terminal 3 — the control room, at http://localhost:5173
pnpm --filter @mohar/control-room dev
```

## Status

Working: the hash-chained ledger, device enrolment, the custody projection, the
deny-by-default access engine with six-hourly stage keys, Merkle anchoring, and
the control-room UI. On top of that: sealing a packet with a two-code seam label
(`tools/label-print` and `POST /packages/:id/seal`), the hand-off engine
(dispatch, receive, confirm, with a Transfer Key per leg), the strong room door
(two verified people, every entry and exit recorded), the damaged-label override
(two operators approve it), roster lock and the opening ceremony (the control
room's part time-locked to drand, two officials' shares wrapped to the station;
a roster re-issue when an official changes; an opening with no link to the ledger,
reported and ruled on afterwards),
the watchdog that raises a late hand-off, an unopened packet, an overlong visit
or an unfinished opening, and alerts sent out by Telegram and email. A gateway
stands in front of all of it: operator sessions, device signatures and rate
limits, with the ledger and the access engine on loopback behind it. Each day's
Merkle root is sent to an RFC 3161 timestamp authority, and `/verify` is a
public page that checks a record's inclusion proof in the browser. The seed
tool drives five centres through the real engine — it presents credentials and
accepts whatever the engine rules, rather than asserting outcomes.

Written and not yet run on hardware: the seal lock firmware, and the witness
station's token check. A courier phone app (`apps/field-app`) records signed
scans and can report a damaged label; it does not do hand-offs yet.

Not built: the opening on the ESP32 station (a paired browser stands in for
it), live video for override approval, and `sealkeys`,
`unlock`, `notify`, `render` and `trace` as services of their own — what exists
of the first three runs inside `ledger`. Device attestation is stored and not
verified. The ledger checks no credential itself, so it is only ever run behind
the gateway.

[RUNNING.md](RUNNING.md) carries the honest list of gaps. See
`docs/09-mvp-plan.md` for the 12-week build order.

## Build constraints

Three constraints shape every decision in `docs/`:

1. **Software-first.** The system is software; hardware is a small supporting
   element, never the centre of a design.
2. **Simple ESP32 hardware only.** A room monitor (about Rs 1,250-1,450) for
   door state, footfall and presence, and a fingerprint witness station. No
   custom PCBs or secure elements. The per-centre kit is in `docs/06`.
3. **No paid or premium dependencies.** Self-hosted Postgres, the public drand
   beacon, a free RFC 3161 timestamp authority, OpenStreetMap tiles, WebAuthn
   platform authenticators, Android Keystore attestation.

`docs/adr/0004-no-paid-dependencies.md` lists every substitution made and states
plainly what each one costs in assurance. The three real reductions are: no HSM,
no sealed appliance, and no electronic latch. None of them touch the timelock
beacon, which is the strongest control in the system and is free.
