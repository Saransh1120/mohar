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
| `services/` | Backend services. Only `ledger` is implemented — it also hosts the access engine, registry and auth routes. The other seven directories are placeholders with a README and an empty `src/`. |
| `packages/` | `contracts` (shared types/enums/events), `crypto-core` (chain, Merkle, Shamir, custody keys, drand), `ledger-client`, `ui-kit` |
| `apps/` | `control-room` is the only working UI. `verify-portal`, `centre-client`, `field-app` are not built. |
| `firmware/` | ESP32 room monitor and related sketches |
| `infra/` | SQL migrations, docker, terraform, attestation roots |
| `tools/` | `seed`, `simulator`, `drill`, `demo-setup`, `provision-device`, `monitor-watchdog` |
| `docs/` | Numbered design docs `00`–`12`, plus `docs/adr/` for decisions |

## Commands

```bash
pnpm install
pnpm build                 # turbo run build (tsc -p per package)
pnpm typecheck
pnpm test                  # node --test over built dist/**/*.test.js
pnpm test:crypto           # crypto-core only
pnpm migrate               # needs MIGRATE_DATABASE_URL
pnpm --filter @mohar/ledger start
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
- There is no authentication anywhere — `gateway` owns it and does not exist.
  Nothing may be exposed beyond localhost.

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
