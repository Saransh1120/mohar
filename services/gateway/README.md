# gateway

The one way in to the ledger. For every request it settles which route it is,
who is asking, and how often, and forwards only if all three hold. Whether the
act itself is allowed stays with the engine behind it.

```bash
DATABASE_URL=postgres://mohar_app:...@localhost:5432/mohar pnpm start
```

from the repo root runs the ledger on loopback and this in front of it. On its
own, with a ledger already listening:

```bash
LEDGER_URL=http://127.0.0.1:8091 GATEWAY_PORT=8081 pnpm --filter @mohar/gateway start
```

## What is where

| File | What it does |
| --- | --- |
| `src/routes/policy.ts` | The table: every route, the credential it needs, the limit it is counted against. Also reduces a path to the one form that is judged and forwarded |
| `src/auth/session.ts` | Resolves a bearer token by asking the ledger (`GET /auth/me`), and issues one-use tickets for `EventSource` streams |
| `src/auth/device.ts` | Verifies a device's signature over a request, or over the event in the body, against the key the ledger has for it |
| `src/ratelimit/limiter.ts` | A token bucket per (limit, caller) |
| `src/upstream.ts` | The one HTTP connection to the ledger, streamed both ways |
| `src/app.ts` | Puts them in order and records what was refused |
| `src/config.ts` | The limits and the environment |

The gateway has no database connection. What it knows about an account or a
device it asks the ledger for, so a compromised gateway can do what the
ledger's API allows and nothing more.

## Its own routes

| Route | Who | What |
| --- | --- | --- |
| `POST /gateway/stream-ticket` | a signed-in account | a ticket that opens one stream within thirty seconds: `GET /alerts/stream?ticket=…` |
| `GET /gateway/status` | control room | what has been refused since the process started, by reason, with the evidence |

## A refusal

```json
{ "error": "This is done by a control room operator.",
  "reason": "role_not_permitted", "roleHeld": "observer", "roleNeeded": "control_room" }
```

`401` when the credential is missing or did not verify, `403` when it verified
and is not enough, `429` with `Retry-After` when a limit is spent, `400` for a
path with an empty, dotted or escaped segment, `502` when the ledger is not
answering. A lookup that fails is a `502`, never a `401`: the ledger being down
does not sign anyone out.

## Tests

```bash
pnpm --filter @mohar/gateway test
```

runs the gateway over real HTTP in front of a stand-in ledger: no database.
`tools/e2e/gateway.mjs` runs it in front of the ledger's own routes against
Postgres. What is and is not covered by either is in `RUNNING.md`, under
"The gateway" and "Remaining limits".

See `docs/02-architecture.md`.
