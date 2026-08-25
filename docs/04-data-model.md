# 04 - Data model

Postgres. Two classes of table: **mutable reference data** (exams, centres,
rosters) and the **immutable ledger** (everything that records what happened).
They live in separate schemas with separate database roles.

## Reference data (schema `ref`)

```sql
create table ref.exam (
  id            uuid primary key,
  authority_id  uuid not null references ref.authority(id),
  name          text not null,
  mode          text not null check (mode in ('digital','escorted')),
  starts_at     timestamptz not null,
  drand_round   bigint not null,          -- pinned at package-sealing time
  sides_per_copy int not null,            -- feeds the throughput check
  created_at    timestamptz not null default now()
);

create table ref.centre (
  id            uuid primary key,
  exam_id       uuid not null references ref.exam(id),
  code          text not null,
  geo           geography(point,4326) not null,
  geofence_m    int not null default 150,
  capacity      int not null,
  printers      int not null default 0,   -- verified at accreditation
  has_genset    boolean not null default false,
  unique (exam_id, code)
);

create table ref.person (
  id            uuid primary key,
  role          text not null check (role in
                  ('superintendent','observer','custodian','courier',
                   'district_officer','control_room')),
  govt_id_hash  bytea not null,           -- hashed, never raw
  webauthn_cred jsonb                     -- platform authenticator credential(s)
);

create table ref.roster (            -- who is authorised where, when
  exam_id   uuid not null references ref.exam(id),
  centre_id uuid not null references ref.centre(id),
  person_id uuid not null references ref.person(id),
  valid_from timestamptz not null,
  valid_to   timestamptz not null,
  primary key (exam_id, centre_id, person_id)
);

create table ref.device (            -- attested phones, centre PCs, room monitors
  id            uuid primary key,
  kind          text not null check (kind in ('field','centre_pc','monitor')),
  pubkey        bytea not null,            -- Keystore/TPM attested public key
  attestation   bytea,                     -- Android Keystore cert chain
  enrolled_at   timestamptz not null,
  revoked_at    timestamptz
);

create table ref.package (
  id            uuid primary key,
  exam_id       uuid not null references ref.exam(id),
  centre_id     uuid not null references ref.centre(id),
  seal_serial   text,                      -- numbered one-time plastic seal
  ciphertext_uri text,                     -- digital mode
  copies        int not null,
  state         text not null check (state in
                  ('sealed','in_transit','at_custodian','at_centre',
                   'opened','returned','compromised'))
);
```

## Ledger (schema `led`) - append-only

```sql
create table led.event (
  seq           bigserial primary key,
  id            uuid not null unique,
  exam_id       uuid not null,
  package_id    uuid,
  centre_id     uuid,
  kind          text not null,             -- see event catalogue below
  occurred_at   timestamptz not null,      -- device clock, may skew
  received_at   timestamptz not null default now(),
  clock_skew_ms bigint,                    -- recorded, never corrected silently
  actor_person  uuid,
  actor_device  uuid not null,
  geo           geography(point,4326),
  payload       jsonb not null,
  device_sig    bytea not null,            -- signature over canonical form
  cosign_person uuid,                      -- two-person handoffs
  cosign_sig    bytea,
  prev_hash     bytea not null,
  hash          bytea not null
);

-- Enforced at role level, not application level:
--   revoke update, delete on led.event from app_writer;
--   grant  insert, select on led.event to  app_writer;

create table led.anchor (            -- nightly notarisation
  day          date primary key,
  merkle_root  bytea not null,
  first_seq    bigint not null,
  last_seq     bigint not null,
  tsa_token    bytea not null,       -- RFC 3161 response
  published_at timestamptz not null
);
```

## Custody access keys (schema `led`)

Every stage of custody requires a stage-specific key valid for one **six-hour
epoch**. See `adr/0005-custody-keys-expire-by-arithmetic.md` for why the epoch is
derived rather than scheduled, and why the key is hashed rather than stored.

```sql
create table led.custody_stage (     -- the eight points of accountability
  stage         text primary key,    -- seal, dispatch, transit, custodian,
  ordinal       int  not null unique, --   centre, unlock, print, destroy
  description   text not null,
  expected_role text not null        -- who is meant to hold this stage's key
);

create table led.access_key (
  id             uuid primary key,
  package_id     uuid   not null references ref.package(id),
  stage          text   not null references led.custody_stage(stage),
  epoch          bigint not null,    -- floor(unix_seconds / 21600)

  -- The key itself is NEVER stored. Handled exactly as a password would be:
  -- shown once at issue, verified afterwards by hash comparison.
  key_hash       bytea  not null check (octet_length(key_hash) = 32),
  fingerprint    text   not null,    -- leading hash bytes; safe to log and print

  issued_to_person uuid references ref.person(id),
  issued_to_role   text not null,
  valid_from     timestamptz not null,   -- epoch start minus 30 min grace
  valid_to       timestamptz not null,   -- epoch end plus 30 min grace
  revoked_at     timestamptz,
  revoked_reason text,

  unique (package_id, stage, epoch)  -- one live key per stage per epoch
);

create table led.access_attempt (    -- every presentation, accepted or refused
  seq            bigserial primary key,
  id             uuid not null unique,

  package_id     uuid references ref.package(id),
  stage          text references led.custody_stage(stage),

  -- A null key_id with a non-null fingerprint means someone presented something
  -- we have never issued. That distinction is worth a great deal: a stale key is
  -- a process failure, an unissued one is a person to find.
  presented_fingerprint text,
  key_id         uuid   references led.access_key(id),
  key_epoch      bigint,
  current_epoch  bigint not null,

  actor_device   uuid references ref.device(id),
  actor_person   uuid references ref.person(id),
  actor_role     text,

  outcome        text   not null check (outcome in ('granted','denied')),
  deny_reasons   text[] not null default '{}',   -- every failing check
  checks_passed  text[] not null default '{}',

  -- Evidence, not verdicts. "412 m from the centre" can be re-examined later;
  -- "outside geofence" cannot.
  lat, lon, geo_accuracy_m, distance_m  double precision,
  seal_serial_read text,
  clock_skew_ms  bigint,
  device_kind    text,
  session_id     uuid,
  event_id       uuid,               -- the signed event this produced, if any

  attempted_at   timestamptz not null,
  decided_at     timestamptz not null default now()
);

-- Keys may be revoked but never erased:
--   grant select, insert, update on led.access_key    to mohar_app;
-- Attempts follow the same rule as led.event — the forensic value of a refused
-- attempt is precisely that nobody can remove it:
--   grant select, insert         on led.access_attempt to mohar_app;
```

`led.access_attempt` is kept separate from `led.event` deliberately. An attempt
is not a custody *fact* until the engine has ruled on it; the ruling is what
becomes a signed event. Keeping the raw attempt here means we also retain
presentations that never became events at all — including ones whose fingerprint
matches no key we ever issued.

### Event catalogue (`led.event.kind`)

| Kind | Emitted by | Meaning |
| --- | --- | --- |
| `PACKAGE_SEALED` | sealkeys | Bundle encrypted, shares distributed |
| `SEAL_APPLIED` | field-app | Numbered plastic seal fitted, serial + photo recorded |
| `HANDOFF` | field-app | Custody transferred, both parties signed |
| `SCAN_OBSERVED` | field-app | QR/NFC read; may or may not lead to unlock |
| `ACCESS_REQUESTED` | access | Authorisation session opened |
| `ACCESS_GRANTED` | access | Signed decision receipt issued |
| `ACCESS_DENIED` | access | With reason code - **high intelligence value** |
| `OVERRIDE_USED` | field-app | Operator proceeded past a denial; pages control room |
| `SEAL_MISMATCH` | field-app | Serial read differs from the registered serial |
| `MONITOR_SILENT` | notify | Heartbeat missed; unplugging raises an alarm |
| `ROOM_ENTRY` | room-monitor | Door open + occupancy delta, with in/out count |
| `SHARE_RELEASED` | sealkeys | A Shamir share was handed out |
| `FALLBACK_INVOKED` | sealkeys | Out-of-band S2 issued; dual-authorised |
| `PRINT_STARTED` / `PRINT_COMPLETED` | centre-client | With copy count |
| `KEY_DESTROYED` | centre-client | Zeroisation confirmed |
| `EXCEPTION_RAISED` | any | Anything the operator had to work around |

## Fingerprint records (schema `fp`)

```sql
create table fp.copy (
  id           uuid primary key,
  package_id   uuid not null,
  seat_label   text,                  -- null when per-centre only
  serial       text not null unique,
  permutation  jsonb not null,        -- block-constrained q/option order
  watermark_payload bytea not null,
  answer_key   jsonb not null         -- per-copy mapping for scoring
);

create table fp.attribution (         -- results of trace runs
  id           uuid primary key,
  image_sha256 bytea not null,
  matched_copy uuid references fp.copy(id),
  confidence   numeric(4,3) not null,
  channels     text[] not null,       -- which of permutation/watermark/serial hit
  report_sig   bytea not null,
  created_at   timestamptz not null default now()
);
```

## Two rules that matter more than the schema

1. **The ledger is the source of truth for what happened; reference data is only
   the source of truth for what was planned.** Never reconcile by editing the
   ledger to match the plan.
2. **Denied and failed events are as valuable as successful ones.** A cluster of
   `UNLOCK_DENIED` at 02:40 is the single most actionable signal the system can
   produce. Never prune them.
