# Mohar — sealed examination paper custody chain

A tamper-evident, time-locked custody and distribution system for exam papers.
Read `README.md` for the goals and `RUNNING.md` for the honest list of gaps
before assuming a service exists.

## Stack

TypeScript (ESM, NodeNext) on Node 24, pnpm 9 workspaces, turborepo, Fastify,
PostgreSQL 18, Zod, `@noble/*` for crypto. React 18 + Vite for the web apps.
ESP32 firmware in `firmware/`, written as Arduino sketches.

## Layout

| Path | What lives here |
| --- | --- |
| `services/` | Backend services. `ledger` hosts the chain, registry and auth routes, sealing, the hand-off, strong room and opening engines, the watchdog and the alert notifier. `gateway` is the one way in: operator sessions, device signatures, rate limits; it forwards to the ledger and holds no database credential. `access` is the access engine as its own package. The rest are placeholders with a README and an empty `src/`. |
| `packages/` | `contracts` (shared types/enums/events), `crypto-core` (chain, Merkle, Shamir, custody keys, drand), `ledger-client`, `ui-kit` |
| `apps/` | `control-room` is the only working UI. `verify-portal`, `centre-client`, `field-app` are not built. |
| `firmware/` | ESP32 room monitor and related sketches |
| `infra/` | SQL migrations, docker, terraform, attestation roots |
| `tools/` | `seed`, `label-print`, `e2e`, `run-gated`, `simulator`, `drill`, `demo-setup`, `provision-device`, `monitor-watchdog` |
| `docs/` | Numbered design docs `00`–`12`, plus `docs/adr/` for decisions |

## Commands

```bash
pnpm install
pnpm build                 # turbo run build (tsc -p per package)
pnpm typecheck
pnpm test                  # node --test over built dist/**/*.test.js
pnpm test:crypto           # crypto-core only
pnpm migrate               # needs MIGRATE_DATABASE_URL
pnpm start                 # gateway :8081, ledger :8091 and access :8082 on loopback
pnpm --filter @mohar/ledger start   # the ledger alone on :8081, every route open
pnpm --filter @mohar/control-room dev
```

Tests run against `dist/`, so **build before testing**. There is no lint tooling
configured despite the `lint` turbo task — do not invent one.

## Conventions

- Every package compiles under the strict flags in `tsconfig.base.json`,
  including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Do not
  loosen them or reach for `any` to get past a type error.
- Shared types belong in `@mohar/contracts`; crypto primitives in
  `@mohar/crypto-core`. Services import them as `workspace:*`, never by
  relative path across package boundaries.
- Run migrations as `mohar_migrator`, never as `mohar_app`. The app role's lack
  of `UPDATE`/`DELETE` on `led.event` *is* the append-only guarantee, and the
  ledger refuses to boot if that check fails.
- `services/gateway` is the only thing that checks who is asking. The ledger
  checks no credential of its own, so it is run behind the gateway on loopback
  (`pnpm start`) and never exposed directly. A new ledger route needs a row in
  `services/gateway/src/routes/policy.ts`; without one it is restricted to a
  control room operator (or, for a `GET`, any signed-in account), not open.
- The gateway never re-serialises a body: signed bytes go through as they
  arrived. Nothing between a device and the ledger may parse and re-encode JSON.

## Project rules

- **Real engines, not asserted outcomes.** Tools and demos must present inputs
  to the actual engine and report whatever it rules. Never hardcode a verdict,
  a hash, or a custody state to make a demo look right.
- **No severity labels in alerts.** Alerts state what happened and what is
  known; they do not rank themselves as critical/high/medium.
- **Firmware ships as Arduino sketches**, built in the Arduino IDE. No
  PlatformIO layouts.
- **No paid or premium dependencies** — see `docs/adr/0004-no-paid-dependencies.md`.
  Software-first; hardware stays a small supporting element under Rs 1,200.
- Answer engineering questions directly. Skip pitch framing and "tell the judge"
  phrasing unless the request is explicitly about the pitch.
