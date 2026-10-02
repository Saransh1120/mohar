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

`pnpm start` starts the access engine, ledger and gateway as separate processes.
The access engine listens only on `127.0.0.1:8082` by default. To run it by
itself while developing, use:

```bash
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  pnpm --filter @mohar/access start
```

Set `ACCESS_URL` to use an already running access service; the launcher then
does not start another one. The ledger keeps an in-process compatibility path
only when started directly without `ACCESS_URL`.

**1. The API: the gateway, with the ledger behind it** (port 8081):

```bash
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  pnpm start
```

`pnpm start` runs three processes. `services/gateway` takes port 8081 on every
interface, which is the port everything already points at: the control room's
`/api` proxy, a room monitor's `LEDGER_BASE_URL`, a host's `PORT`. The ledger
moves to `127.0.0.1:8091` and cannot be reached from another machine. See
[The gateway](#the-gateway) for who may call what.

The ledger refuses to boot if it detects a superuser connection, or any role
holding `UPDATE`/`DELETE` on `led.event`. A `LedgerPrivilegeError` means that
check is working — connect as `mohar_app`.

To run the ledger alone on 8081, with no gateway and every route open to
whatever can reach the port, as it was before:

```bash
DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar \
  pnpm --filter @mohar/ledger start
```

It says so in its log when it starts that way.

**2. Seed a pilot exam** (optional, but the UI is empty without it):

```bash
LEDGER_URL=http://127.0.0.1:8091 node tools/seed/dist/index.js
```

The tools do not sign in. They speak to the ledger directly, on loopback, which
is why the address is the ledger's own and not port 8081.

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

Open <http://localhost:5173>. It proxies `/api` to port 8081, so the browser
stays same-origin. The first account created claims the control room as its
operator and registration closes behind it; later accounts are made on the
Accounts page.

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
| `services/ledger` | Append path, chain verification, RFC 3161 anchoring, device registry, custody projection, activity ledger, sealing, hand-off engine, watchdog, alert notifier, strong room door, damaged-label override, roster lock and opening ceremony |
| `services/access` | Access policy and rotating custody keys; runs on a private port when `ACCESS_URL` is set |
| `apps/field-app` | Courier phone PWA for signed QR observations and offline queuing; `/field/` on the Netlify build |
| `/verify` | Public Merkle inclusion check and downloadable RFC 3161 response |
| `services/gateway` | The one way in. Operator sessions, device request signatures, signed-event checks, rate limits, stream tickets; forwards to the ledger and holds no database credential |
| `apps/control-room` | React + Vite + Leaflet. Overview, packages, custody timelines, transfers, alerts, strong rooms, rosters, opening ceremonies, override approval, activity ledger, key management, devices, accounts, integrity |
| `tools/seed` | Key generation, device enrolment, and a custody walkthrough driven through the real engine |
| `tools/label-print` | Prints a packet's two-code seam label and signs its sealing |
| `tools/seal-lock-command` | Signs a short-lived UART command after a recorded, granted unlock attempt; requires migration 010 |
| `tools/e2e` | End-to-end checks against a real Postgres: `transfer.mjs`, `seal.mjs`, `sweeps.mjs`, `doors.mjs`, `opening.mjs`, `gateway.mjs`, `device-seq.mjs`, `public-scan.mjs`, `journey.mjs` |
| `tools/run-gated` | `pnpm start`: the access engine and ledger on loopback with the gateway in front, as one command |

## Sealing a packet

The press operator's device makes the label and signs the sealing; the server
never sees the seam secret.

```bash
node tools/label-print/dist/index.js print --package <package-id>
```

This writes `labels/<serial>.svg` at print size (48 x 34 mm, two QR codes at
error-correction level L, the seam id and the serial) and prints the
commitment. The SVG is the only copy of the secret, and `labels/` is
git-ignored. Print it, apply it across the flap, photograph it, then:

```bash
node tools/label-print/dist/index.js seal --package <package-id> --photo <photo.jpg>
```

That signs `SEAL_APPLIED` with the device key in `secrets/press-device.json`
(enrolled on first use) and posts it to `POST /packages/:id/seal`, which appends
the event and registers the commitment every later scan is checked against. A
second sealing of the same packet, or a serial that is not the planned one, is
recorded in the chain and refused: the first commitment is never replaced.

## Alerts and who is told

The watchdog raises `LEG_OVERDUE` for a hand-off past its expected time and
`PACKET_UNOPENED_OVERDUE` for a packet with no opening on the chain fifteen
minutes before its exam. Both go to `led.alert` and the Alerts page, which is
pushed changes over `GET /alerts/stream`.

To be told somewhere other than that page, set either or both before starting
the ledger:

| Channel | Environment |
| --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (and `TELEGRAM_API_URL` for a self-hosted Bot API server) |
| Email | `SMTP_URL` (e.g. `smtp://user:pass@host:587`), `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` |

Every send is a row in `led.alert_delivery`, failed ones included, and a failed
channel is retried five times. An alert more than a day old is not sent, so a
channel configured today does not announce last month. `NOTIFY_MS` sets how
often the notifier looks (default 5000; `0` turns it off).
The Alerts page shows the latest recorded delivery result for each channel on
each alert. "Accepted" means Telegram or the SMTP server accepted the message;
it does not prove a person read it.

## The gateway

`services/gateway` settles three things about every request and forwards it
only if all three hold: which route it is, who is asking, and how often. Whether
the act itself is allowed stays with the engine behind it, which records the
attempt either way. The whole policy is one table,
`services/gateway/src/routes/policy.ts`.

| What is asked | Who may ask |
| --- | --- |
| `GET /ping`, `/health`, `/auth/config`, `/auth/me`; `POST /auth/signin`, `/auth/signup`, `/auth/signout`; `GET /anchors`, `/counters`, `/verify/inclusion/:id` | anyone |
| `POST /events`, `/events/batch`, `/packages/:id/seal` | the body is an event signed by an enrolled, unrevoked device |
| a hand-off step, a strong room entry or exit, a ceremony step, a station's unwrap key | a request signed by the enrolled device. A session does not stand in for it |
| `POST /access/request` | a request signed by an enrolled device, or a signed-in account |
| `POST /keys/issue`, `/keys/rotate`, `/devices`, `/fingerprints`, `/legs`, `/rooms`, `/overrides/:id/decision`, `/auth/accounts`, `/demo/*`, … | a signed-in account whose role is `control_room` |
| every other `GET` | a signed-in account |
| anything not listed | a read needs an account, anything else needs `control_room` |

A route added to the ledger and not listed is therefore over-restricted until
somebody lists it, never open.

**A device signing a request.** Four headers, `x-mohar-device`,
`x-mohar-timestamp`, `x-mohar-nonce` and `x-mohar-signature`: Ed25519, with the
device's enrolled key, over the method, the path, the time, the nonce and the
SHA-256 of the body as sent (`signedRequestHeaders` in `@mohar/crypto-core`).
The time must be within two minutes of the gateway's, a nonce is accepted once,
and a `deviceId` in the body or the path must be the device that signed. A room
monitor posting events needs none of this: its events are already signed.

**Limits**, per caller, counted in the gateway's memory:

| Limit | At once | Then per minute | Counted against |
| --- | --- | --- | --- |
| `access` | 5 | 1 | caller, packet and stage: guesses at a custody key |
| `signin` | 10 | 2 | the address, and the username |
| `field` | 30 | 30 | a door, a hand-off step, a ceremony step |
| `events` | 120 | 240 | the device |
| `key_issue` | 20 | 20 | the account |
| `enrol` | 20 | 2 | the account |
| `read` / `write` | 300 / 60 | 600 / 60 | the caller |
| `auth_fail` | 20 | 10 | the address: credentials that did not verify |

`GATEWAY_LIMITS` overrides any of them, as JSON:
`{"access":{"burst":3,"perMinute":1}}`.

**A refusal says what was found**: the role held against the role needed, the
skew in seconds, which header was missing, the limit that was hit. The last two
hundred are on the Accounts page (`GET /gateway/status`) and every one is a log
line.

**Sign-up is closed** once an account exists. The first sign-up claims the
system as a control room operator; later accounts are created by an operator on
the Accounts page, and disabled there, never deleted. `ALLOW_SIGNUP=true` on the
ledger opens registration to anyone, role chooser included.

| Environment | Process | Meaning |
| --- | --- | --- |
| `PORT` | `pnpm start` | the public port, the gateway's. Default 8081 |
| `LEDGER_PORT` | `pnpm start` | the ledger's loopback port. Default 8091 |
| `HOST` | ledger | the interface the ledger binds. `pnpm start` sets `127.0.0.1` |
| `GATEWAY_SECRET` | both | when set, the ledger answers only requests that carry it. For a ledger that cannot be bound to loopback |
| `TRUST_PROXY` | gateway | `true`, or the proxies' addresses. Behind a reverse proxy, without this every caller is the proxy and shares one allowance |
| `CORS_ORIGINS` | gateway | origins whose pages may read responses. Default `http://localhost:5173` |
| `ALLOW_SIGNUP` | ledger | `true` opens registration |

On a host that runs one command and hands it a `PORT` (Render), the start
command is `node tools/run-gated/index.mjs`, with `TRUST_PROXY=true`.

## Checking it against a real database

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/gateway.mjs
```

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/seal.mjs
```

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/sweeps.mjs
```

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/doors.mjs
```

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/opening.mjs
```

All five run the built ledger code inside one transaction and roll it back, so
they are safe to point at the development database. `transfer.mjs` commits, and
needs a throwaway one. `gateway.mjs` starts the built gateway in front of the
ledger's routes on two loopback ports and calls it over HTTP: the three routes
that were open, a device-signed hand-off step reaching the hand-off engine, a
replay, a revoked device, a stream ticket, and the sign-in limit. `opening.mjs` needs the internet and takes about half a
minute: it locks a roster, waits for drand to publish the round the key was
locked to, and opens the envelope with it.

## The strong room, the override and the opening

Four control room pages, each with a console that drives the real engine. All
of them need migration 009.

**Strong rooms.** "New strong room to try" registers a room, a door device and
three people with a finger each on its reader. The door opens to two people,
each verified, within 120 seconds of each other; one person, the same person
twice, a courier, a borrowed finger or a weak match is refused, and every
attempt is recorded. An exit records how long the visit lasted. A visit past
its limit (twice the expected time, and at least five minutes over) raises
`DWELL_EXCEEDED`, at the exit or, if there is no exit, from the watchdog. Where
the room has a monitor, the `ROOM_ENTRY` events that monitor signed are summed
over the visit, and more counted in than admitted raises `FOOTFALL_MISMATCH`.

**Override approval.** On the Transfers console, choose "damaged, will not
scan", attach a photograph and report it. The request appears on the Override
approval page and raises `SEAM_DECODE_FAILED`. Two operators, each signed in to
their own account, each tick that they saw the packet and both officers on
video and approve; the second approval raises `SEAM_MANUAL_OVERRIDE`. Only then
does the hand-off engine accept the override in place of the scan, for that leg
only. The page also counts approved overrides per hundred legs by centre, route
and officer.

**Rosters and Ceremonies.** On Ceremonies, "New packet due to open" makes this
browser the opening station (an enrolled device with a non-extractable X25519
unwrap key), and makes a packet at its centre, three officials and an unlocked
roster, with the exam starting in 17 minutes so the packet is due to open in
two. On Rosters, sign in and lock it: that generates the opening key, time-locks
the control room's part to the drand round for that minute, wraps each
official's share to the station, and keeps none of it readable. Back on
Ceremonies the console scans the packet, identifies two officials (each one's
wrapped share is released only when they pass, and is unwrapped in the
browser), confirms the serial, and then waits for the round. Before it, drand
has nothing to give and the page says so. After it, the browser opens the
envelope, assembles the key, and the ledger grants if the key hashes to the
commitment made at the lock. A ceremony started and not released by its minute
raises `CEREMONY_INCOMPLETE`.

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

## Remaining limits

Stated plainly, so the endpoints that do exist do not imply more than they should:

- **Attestation is accepted but never verified.** `POST /devices` stores an
  Android Keystore / TPM chain without checking it against a root of trust.
  Through the gateway, enrolment takes a control room operator's session, so who
  enrolled a device is known; what hardware holds its key is that operator's
  word. See `adr/0003`.
- **The gateway is the only thing that checks who is asking.** The ledger
  checks no credential of its own beyond the signature on an event and the
  operator's role on the three account routes. Started alone
  (`pnpm --filter @mohar/ledger start`) it listens on every interface and is as
  open as it was before; `pnpm start` is what binds it to loopback. Between the
  two processes there is no mTLS: loopback, or a shared `GATEWAY_SECRET` over
  plain HTTP. `pnpm start` starts the access service on loopback, but the gateway
  secret is not checked by that service.
- **A console signs as its device with a key the browser holds.** The
  Transfers, Strong rooms and Ceremonies consoles sign every step with the
  device's own Ed25519 key, and the gateway takes nothing else for those
  routes: an operator's session alone is refused, and so is a request naming
  another device. The key is generated non-extractable in the browser of
  whoever is signed in, when "New packet", "New strong room" or "New packet due
  to open" makes the device. That is a browser standing in for a handheld, not
  a handheld: a device in the field would hold its key in its own hardware. A
  demonstration device made before this, or in another browser, has a key
  nobody holds and its console can no longer act; make a new one.
- **The engines are not told that the gateway verified the device.** The
  gateway refuses a request it cannot tie to the device, so what reaches an
  engine did come from it, but the engine's own record still shows only
  `device_enrolled`, as it would for a ledger reached directly.
- **`POST /access/request` still takes a session.** The Unlock page asks the
  access engine on behalf of an ESP32 station whose key the browser does not
  hold, so on that route a signed-in account can name any device.
- **A role decides what an account may change, not what it may see.** Any
  signed-in account reads everything and may drive any engine's console. There
  is no scoping to a centre or a district, and a session is a password only:
  the WebAuthn settings in `.env.example` are read by nothing.
- **The gateway's limits and its record of refusals are in memory.** One
  process, so one count. A restart resets both, and a second gateway behind a
  load balancer would keep its own. Refusals are also log lines; they are not
  rows in the database, because the gateway has no connection to it.
- **The tools do not sign in.** `tools/seed`, `label-print`, `demo-setup`,
  `provision-device` and `monitor-watchdog` speak to the ledger directly on
  loopback (`LEDGER_URL=http://127.0.0.1:8091`). With `GATEWAY_SECRET` set they
  are refused, and there is no credential to give them.
- **A field phone is enrolled by an operator standing at it.** The operator
  types their own username and password into the field app. It signs in,
  checks that the centre belongs to the exam and that the person is on the
  register, posts the phone's public key to `POST /devices`, and signs out
  again. The session is never written to the phone's storage. What this is not:
  the operator's password is typed on a phone the courier keeps, and nothing
  attests what hardware holds the key. A revoked phone cannot be enrolled again
  without clearing the app's storage, which also removes its retained photos.

- **The Render web service now starts through the gateway** with
  `node tools/run-gated/index.mjs` (deployed at `5a66964`). The access engine
  and ledger bind to loopback; an unauthenticated `/devices` request now returns
  401. The service's `DATABASE_URL` points to Neon `neondb`, not the Render
  PostgreSQL database in the same project. The Neon owner applied migrations
  007–010 on Oct 2, 2026; the Render PostgreSQL database also has 001–010.
  Render has `TRUST_PROXY=true` so gateway rate limits use the forwarded client
  address. The configuration deploy succeeded and `/api/health` returned 200
  while unauthenticated `/api/devices` returned 401.
- **Keys are delivered by being displayed.** There is no channel that gets a key
  to a courier's phone; the control room reads it out. That is the intended MVP
  behaviour but it is the weakest link in the key lifecycle.
- **TSA availability and trust are operational dependencies.** The ledger
  verifies the RFC 3161 response before storing it and retries pending roots
  hourly. An outage leaves the root unnotarised until a later successful retry.
  A real FreeTSA response was requested and verified with OpenSSL on Oct 2,
  2026; that test used a random root and did not create a production anchor.
- **`sealkeys`, `unlock`, `render`, `trace`, `notify`** remain planned services.
  The access engine and gateway now have separate packages and processes.
- **The end-to-end checks are scripts, not part of `pnpm test`.** `pnpm test`
  runs the unit suites (crypto-core, the access engine's checks, the hand-off
  engine, the watchdog and notifier wording, the label tool). The checks that
  need Postgres are in `tools/e2e` and are run by hand.
- **The public verify page and field PWA exist, and were clicked through in a
  desktop browser against the gateway and the ledger on Oct 2, 2026.** On the
  field app: enrolment (a wrong operator password and an unknown person were
  each refused), a scan whose QR image was decoded and whose `SCAN_OBSERVED`
  event was appended to the chain with the photo's hash, a damaged-label
  request recorded by the override engine as pending, a scan made while the API
  was stopped that stayed queued and was accepted under the same event ID once
  it was back, and a scan from a revoked phone that the gateway refused and the
  queue kept with the reason. On `/verify`: an event of an anchored day verified
  in the browser, first with its timestamp pending and then with the RFC 3161
  response attached; a root that was not the served one was reported as such,
  apart from the inclusion check; an event whose day has no anchor said so.
  Not done: none of this was run on a phone, so the camera capture, installing
  the PWA, the service worker's offline cache and the browser's own
  online/offline events were not exercised, and the timestamp response was not
  downloaded or checked with an RFC 3161 verifier from that page. The field PWA
  does not provide hardware attestation, biometric hand-offs or upload photo
  bytes to the server. `centre-client` remains planned.
- **Sealing registers the seam label and nothing else.** The Opening Key is not
  split at sealing, because no service exists to hold the parts. The label tool
  writes both PDF and SVG. The label comes out 48 x 34 mm at QR version 4, not
  the 60 x 25 mm at version 3 the physical-layer doc aims for: a seam URL with
  a real host name does not fit version 3. The printed label has not been
  tested on destructible vinyl or scanned off a real packet.
- **The Transfers page still seals through `POST /demo/journey`**, which writes
  the label's commitment as reference data without a signed event, so that the
  page can show a hand-off without a press device. Set `DISABLE_DEMO_ROUTES=1`
  to leave it unregistered. The console signs each step as the courier's
  handheld, with a key the browser made when the packet was made. It simulates
  the fingerprint reader — it says so on the page.
- **The watchdog runs inside the ledger process**, not in `services/watchdog`,
  which does not exist yet. It sweeps every 30 s (`LEG_WATCHDOG_MS`, `0` turns
  it off) and records both an alert and a service-signed chain event.
  `PACKET_UNOPENED_OVERDUE` looks back 48 hours and counts as an opening
  either an `OPEN_CEREMONY`, `PACKET_OPENED` or `PRINT_STARTED` event or an
  `unlock` the access engine granted. The opening engine now appends
  `OPEN_CEREMONY` and `PACKET_OPENED` with the ledger's enrolled service key.
- **The engines' decisions now appear on the signed chain.** The hand-off,
  strong-room, override and opening routes append service-signed events, as do
  the overdue sweeps. `tools/e2e/journey.mjs` passed 33 checks on Oct 2, 2026:
  seal, three hand-offs, strong-room visits, roster lock, opening and an overdue
  leg, with every signature and chain hash checked. The transaction rolled back.
- **The live streams do not work through Netlify.** Its `/api` proxy holds back
  small server-sent frames and answers 504 after about thirty seconds, so on
  the deployed site `GET /alerts/stream` never opens (and `/events/stream` goes
  quiet once it has caught up). The Alerts page notices and polls every five
  seconds instead. Opened against the ledger directly, or locally, the streams
  work.
- **Telegram delivery was checked against a real bot on Oct 2, 2026.** Render
  booted with `channels:["telegram"]`. A packet planned with leg 1 due in one
  minute raised `LEG_OVERDUE` on the live Alerts page (alert
  `1829e0bb-5e22-43a3-ade0-31522ae0de8c`, packet `PKT-JPR-7288`). The
  message appeared in the bot chat, and Neon `led.alert_delivery` recorded
  `channel=telegram`, `outcome=sent`, `detail=null` for that alert. Gmail SMTP
  has not been configured or tested; the station buzzer is not wired to alerts.
- **Device sequence checks are implemented, but coverage is partial.** Migration
  012 was applied on Neon on Oct 2, 2026. A signed event with `deviceSeq` is
  checked against that device's previous number; a gap appends a
  `DEVICE_SEQ_GAP` alert. `tools/e2e/device-seq.mjs` passed 7 checks against
  local Postgres. The shared ESP32 library persists its counter in NVS but has
  not been flashed. The schema still accepts events without `deviceSeq`, and
  the field app and other producers do not yet supply it on every event.
- **Public seam scans have a signed record and a neutral `/s` page.** A known
  seam scanned in a public browser posts only its opaque ID and QR half to
  `POST /public/seam-scan`; the page removes the secret fragment before the
  request. The ledger appends `UNAUTHORIZED_SCAN` and raises an alert. Unknown
  IDs receive the same public response. `tools/e2e/public-scan.mjs` passed 8
  checks against local Postgres. A same-tab second QR scan initially left the
  fragment in the address bar; commit `a8d5a50` handles `hashchange`. Both a
  first scan and a second scan stripped a synthetic test fragment in the local
  browser, and the latest Netlify deploy preview showed the same result. The
  live API route returned 400 for an invalid body, as expected; no real label
  was scanned on production.
- **Netlify production deploys are paused by the team's credit limit.** On Oct
  2, 2026 the Netlify dashboard showed the latest branch deploy preview ready
  and the production deploy failed immediately. Production still serves commit
  `898a241`; the `/s` path there redirects to sign-in. Netlify says production
  deploys resume after a plan upgrade or the next billing cycle. No upgrade was
  made.
- **The witness station's token check and single-origin CORS have not been
  compiled or flashed.** The firmware change is written for both the Arduino
  sketch and the `witness-node` source; this machine has no ESP32 toolchain, so
  it has not been built. A `node_config.h` from before the change stops the
  build with a message until `STATION_TOKEN` and `CONTROL_ROOM_ORIGIN` are
  added. `firmware/witness-node/src/main.cpp` was already behind the Arduino
  sketch (it lacks the USB transport), so do not run `sync-arduino.py` over the
  sketch.
- **Alerts need migrations 007 and 008, the four newer pages need 009, and
  Rosters needs 011.**
  Without 007 the Acknowledge button returns 503; without 008 the notifier logs
  an error each round and sends nothing; without 009 the Strong rooms, Rosters,
  Ceremonies and Override approval pages get errors from the ledger. The live
  Neon-backed deployment had those missing relations until migration 009 was
  applied on Oct 2, 2026. Migration 011 was applied on Neon as the schema owner
  on Oct 2, 2026; 012 adds the signed device sequence column. All four pages
  now load through the gateway.
- **The newer pages load through the live gateway.** Strong rooms, Rosters,
  Ceremonies and Override approval were opened in a signed-in browser after
  the Neon migrations and returned their empty-state data. The full production
  ceremony and approval forms were not submitted. `doors.mjs` and
  `opening.mjs` cover those routes against a test database; `doors.mjs` passed
  47 checks and `opening.mjs` passed 75 checks on Oct 2, 2026.
- **The offline opening path exists.** `POST /stations/:deviceId/cache` caches
  an envelope and `POST /ceremonies/offline` records an `envelope-authorized`
  opening. A failing account raises `OFFLINE_OPENING_DISPUTED`. A station
  holding the cache has all three wrapped shares, so enforcing two officials
  at the reader is the station's responsibility; the time lock still applies.
  The beacon is fetched from a public relay, with no LAN cache. Opening
  outside the ceremony window is still not built.
- **The opening station is a paired browser, not the ESP32.** The witness
  station firmware does not hold envelopes or unwrap shares. The console's
  fingerprint is simulated, and no face reading is sent, so the engine records
  that check as not evaluated.
- **The opening key is made when the roster is locked, not when the packet is
  sealed.** The design splits the key at the press and re-wraps the shares a
  day ahead; here both happen at the lock, so nothing holds role-bound shares
  in between. A lock inside the last day before the exam needs a stated reason
  and is recorded as late in `led.roster_issue`.
- **Roster re-issue exists.** `POST /rosters/:centreId/:session/reissue`
  gives every unopened packet at the centre a new key as the next issue. It is
  refused after the opening minute; a ceremony begun under the earlier issue
  must start again.
- **A station's unwrap key is registered by the station.** The gateway takes
  the device's own signature for it, from the device named in the path. A
  directly reached ledger checks nothing; a second, different key is refused
  either way.
- **The strong room door has no actuator and its demonstration room has no
  monitor.** The engine decides and records; nothing physical opens. Footfall
  is checked only for a room registered with a monitor device whose signed
  `ROOM_ENTRY` events are on the chain.
- **The override's live video is the operator's word.** No call is carried by
  this system or the field PWA. What is recorded is
  that two named operators each stated they saw the packet and both officers.
- **Some service events are still absent from the signed chain.** `STORED`,
  `RELEASED` and `SEAM_MANUAL_OVERRIDE` are not appended: nothing links a leg
  to a room, and override approvers are operator accounts while the contract
  names a person. A strong room attached to no centre has no exam to file
  under, so its events are not written.
- **The seal-lock sketch is not a field-tested lock.** The ESP32-C6 source and
  Arduino sketch verify signed, expiring, one-use commands and spool signed
  reports. Migration 010 and `tools/seal-lock-command` issue short-lived commands
  from recent granted unlock attempts. An opened enclosure or a failed closure
  creates an alert when its signed event reaches the ledger. The seal-lock
  sketch does not yet attach a sequence to its signed reports.
  The sketch compiles for `esp32:esp32:esp32c6` with arduino-cli 1.5.1, core
  3.3.11, Crypto 0.4.0 and RTClib 2.1.4, with no warnings: 447294 bytes, 34% of
  program storage. A review for hardware safety changed four things. The coil
  is cut by a one-shot hardware timer armed before it is energised, as well as
  by the loop. The board does no Wi-Fi join and no HTTP while the coil is on,
  where before a ledger that did not answer could hold it energised for up to
  24 seconds. The output latch is set before the pin becomes an output. The
  example pins moved off GPIO 4 and 5, which are ESP32-C6 strapping pins, and
  the sketch will not compile with the solenoid on one.
  **No board was available, so nothing has been flashed or measured.** Pending
  on hardware: driver polarity and the gate's pull resistor holding the coil
  off through reset and flashing; the pulse length on a scope and the coil's
  temperature over repeated pulses; a brown-out when the coil pulls in; power
  cut mid-pulse and after the counter write; tamper open during a pulse;
  counter persistence across resets and a replayed command being refused; a
  full or failed LittleFS partition; DS3231 power loss; a command sent over a
  real UART; and secure boot with flash encryption. A refused command is said
  on the UART only and leaves no signed record, because there is no event kind
  for one.

The natural next steps are moving the opening onto the ESP32 station, a way
for a field device to be enrolled without an operator typing its key, and real
attestation verification at enrolment.
