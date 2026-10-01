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
| `services/ledger` | Append path, chain verification, anchoring, device registry, custody projection, **access decision engine**, **rotating custody keys**, activity ledger, **sealing**, **hand-off engine**, **watchdog**, **alert notifier**, **strong room door**, **damaged-label override**, **roster lock and the opening ceremony** |
| `apps/control-room` | React + Vite + Leaflet. Overview, packages, custody timelines, transfers, alerts, strong rooms, rosters, opening ceremonies, override approval, activity ledger, key management, devices, integrity |
| `tools/seed` | Key generation, device enrolment, and a custody walkthrough driven through the real engine |
| `tools/label-print` | Prints a packet's two-code seam label and signs its sealing |
| `tools/e2e` | End-to-end checks against a real Postgres: `transfer.mjs`, `seal.mjs`, `sweeps.mjs`, `doors.mjs`, `opening.mjs` |

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

## Checking it against a real database

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

All four run the built ledger code inside one transaction and roll it back, so
they are safe to point at the development database. `transfer.mjs` commits, and
needs a throwaway one. `opening.mjs` needs the internet and takes about half a
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
- **`sealkeys`, `unlock`, `render`, `trace`, `notify`, `gateway`** are README
  files and empty `src` directories. The access engine, sealing, the hand-off
  engine, the watchdog and the notifier all live inside `ledger` for now and
  should move to their own services.
- **The end-to-end checks are scripts, not part of `pnpm test`.** `pnpm test`
  runs the unit suites (crypto-core, the access engine's checks, the hand-off
  engine, the watchdog and notifier wording, the label tool). The checks that
  need Postgres are in `tools/e2e` and are run by hand.
- **`verify-portal`, `centre-client`, `field-app`** are unstarted.
- **Sealing registers the seam label and nothing else.** The Opening Key is not
  split at sealing, because no service exists to hold the parts. There is no
  PDF output, only SVG. The label comes out 48 x 34 mm at QR version 4, not
  the 60 x 25 mm at version 3 the physical-layer doc aims for: a seam URL with
  a real host name does not fit version 3. The printed label has not been
  tested on destructible vinyl or scanned off a real packet.
- **The Transfers page still seals through `POST /demo/journey`**, which writes
  the label's commitment as reference data without a signed event, so that the
  page can show a hand-off without a press device. Set `DISABLE_DEMO_ROUTES=1`
  to leave it unregistered. The hand-off routes check a device id but no device
  signature, and the Transfers console simulates the fingerprint reader — it
  says so on the page.
- **The watchdog runs inside the ledger process**, not in `services/watchdog`,
  which does not exist yet. It sweeps every 30 s (`LEG_WATCHDOG_MS`, `0` turns
  it off) and writes to `led.alert`, not a signed chain event.
  `PACKET_UNOPENED_OVERDUE` looks back 48 hours and counts as an opening
  either an `OPEN_CEREMONY`, `PACKET_OPENED` or `PRINT_STARTED` event or an
  `unlock` the access engine granted. No engine emits `OPEN_CEREMONY` yet, so
  for now the granted unlock is what keeps a packet opened on the Ceremony page
  from raising this alert.
- **The live streams do not work through Netlify.** Its `/api` proxy holds back
  small server-sent frames and answers 504 after about thirty seconds, so on
  the deployed site `GET /alerts/stream` never opens (and `/events/stream` goes
  quiet once it has caught up). The Alerts page notices and polls every five
  seconds instead. Opened against the ledger directly, or locally, the streams
  work.
- **The notifier has been run against a stand-in channel, not a real bot or
  mail server.** The Telegram request shape is unit-tested and delivery,
  retries and the record of attempts are checked against Postgres, but no
  message has been sent to a real Telegram chat or SMTP server from this repo.
  The station buzzer is not wired to alerts.
- **The witness station's token check and single-origin CORS have not been
  compiled or flashed.** The firmware change is written for both the Arduino
  sketch and the `witness-node` source; this machine has no ESP32 toolchain, so
  it has not been built. A `node_config.h` from before the change stops the
  build with a message until `STATION_TOKEN` and `CONTROL_ROOM_ORIGIN` are
  added. `firmware/witness-node/src/main.cpp` was already behind the Arduino
  sketch (it lacks the USB transport), so do not run `sync-arduino.py` over the
  sketch.
- **Alerts need migrations 007 and 008, and the four newer pages need 009.**
  Without 007 the Acknowledge button returns 503; without 008 the notifier logs
  an error each round and sends nothing; without 009 the Strong rooms, Rosters,
  Ceremonies and Override approval pages get errors from the ledger.
- **The four newer pages have not been looked at in a browser.** They build and
  typecheck, the routes behind them pass `doors.mjs` and `opening.mjs`, and the
  station's cryptography (the X25519 unwrap and the drand time lock) was run in
  a real browser against this code. But the control room needs a sign-in, and
  the pages themselves were not opened and clicked through.
- **The opening is the live path only.** A station opening from a cached
  envelope with no network (`envelope-authorized`), an opening outside its
  window with all three officials and the control room's approval, and a
  roster change after locking are designed and not built. The ceremony window
  is closed once the exam starts.
- **The opening station is a paired browser, not the ESP32.** The witness
  station firmware does not hold envelopes or unwrap shares. The console's
  fingerprint is simulated, and no face reading is sent, so the engine records
  that check as not evaluated.
- **The opening key is made when the roster is locked, not when the packet is
  sealed.** The design splits the key at the press and re-wraps the shares a
  day ahead; here both happen at the lock, so nothing holds role-bound shares
  in between. The lock is not held to a day ahead either: it can be done any
  time before the packet's opening minute, and the time is recorded.
- **Registering a station's unwrap key is unauthenticated**, like device
  enrolment. Whoever reaches `POST /stations/:id/wrap-key` first for a device
  sets its key; a second, different key is refused.
- **The strong room door has no actuator and its demonstration room has no
  monitor.** The engine decides and records; nothing physical opens. Footfall
  is checked only for a room registered with a monitor device whose signed
  `ROOM_ENTRY` events are on the chain.
- **The override's live video is the operator's word.** No call is carried by
  this system and there is no field app to place one from. What is recorded is
  that two named operators each stated they saw the packet and both officers.
- **The door, the override and the ceremony write to their own append-only
  tables, not to the signed chain.** No `STRONGROOM_ENTRY`, `OPEN_CEREMONY` or
  `SEAM_MANUAL_OVERRIDE` event is appended, because the ledger has no key of
  its own to sign one with. The hand-off engine is the same.
- **Not built at all:** the seal lock and device sequence numbers.

The natural next steps are moving the opening onto the ESP32 station, rate
limiting on the decision endpoint, and real attestation verification at
enrolment.
