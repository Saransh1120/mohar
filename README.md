# Mohar — Sealed Examination Paper Custody Chain

A tamper-evident, time-locked custody and distribution system for competitive and
government examination papers.

**Design goals** (see `docs/00-overview.md` for why these and not "100% leak-proof"):

1. Collapse the **exposure window** — the time a paper exists in readable form —
   from ~240 hours to under one hour.
2. Make every leak **attributable** to a centre, and where possible a seat,
   within minutes of an image surfacing.
3. Produce a **court-admissible** custody record, because India's exam-fraud
   problem is an evidentiary failure (148 cases since 2015, one conviction)
   more than a detection failure.

**Non-goal:** eliminating leaks entirely. A paper must be readable by humans at
several points in its life. We shrink and instrument those points; we do not
pretend to remove them.

## Repository layout

| Path | What lives here |
| --- | --- |
| `docs/` | Architecture, threat model, crypto design, data model, runbooks |
| `services/` | Backend services (TypeScript / Fastify / Postgres) |
| `apps/` | Control room, verify portal, centre client, Android field app |
| `packages/` | Shared contracts, crypto primitives, ledger client, UI kit |
| `firmware/` | ESP32 room-monitor firmware — the only hardware we build |
| `infra/` | Docker compose, SQL migrations, Terraform, attestation roots |
| `tools/` | Exam simulator, seed data, chaos-drill harness |
| `tests/` | End-to-end, load, and shared fixtures |

## Quick start

Needs Node 24, pnpm, and PostgreSQL 18. Full setup in [RUNNING.md](RUNNING.md).

```bash
pnpm install
pnpm build
MIGRATE_DATABASE_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar pnpm migrate

# terminal 1 — the ledger and access engine
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  node services/ledger/dist/index.js

# terminal 2 — seed a pilot exam (optional; the UI is empty without it)
node tools/seed/dist/index.js

# terminal 3 — the control room, at http://localhost:5173
pnpm --filter @mohar/control-room dev
```

## Status

Working: the hash-chained ledger, device enrolment, the custody projection, the
deny-by-default access engine with six-hourly stage keys, Merkle anchoring, and
the control-room UI. The seed tool drives five centres through the real engine —
it presents credentials and accepts whatever the engine rules, rather than
asserting outcomes.

Not built: `sealkeys`, `render`, `trace`, `notify`, `gateway`, and all clients
except the control room. **There is no authentication anywhere** — `gateway` owns
that and does not exist, so nothing here may be exposed beyond localhost.

[RUNNING.md](RUNNING.md) carries the honest list of gaps. See
`docs/09-mvp-plan.md` for the 12-week build order.

## Build constraints

Three constraints shape every decision in `docs/`:

1. **Software-first.** The system is software; hardware is a small supporting
   element, never the centre of a design.
2. **Simple ESP32 hardware only.** One room monitor under Rs 1,200 for door
   state, footfall and presence. No custom PCBs, secure elements or latches.
3. **No paid or premium dependencies.** Self-hosted Postgres, the public drand
   beacon, a free RFC 3161 timestamp authority, OpenStreetMap tiles, WebAuthn
   platform authenticators, Android Keystore attestation.

`docs/adr/0004-no-paid-dependencies.md` lists every substitution made and states
plainly what each one costs in assurance. The three real reductions are: no HSM,
no sealed appliance, and no electronic latch. None of them touch the timelock
beacon, which is the strongest control in the system and is free.
