-- =============================================================================
-- 001_init — reference data, the append-only ledger, and fingerprint records.
--
-- Run as a migration role that owns the schemas. The application connects as
-- `mohar_app`, which is deliberately NOT granted UPDATE or DELETE on the ledger.
-- See docs/04-data-model.md.
-- =============================================================================

begin;

create extension if not exists "pgcrypto";      -- gen_random_uuid()

create schema if not exists ref;
create schema if not exists led;
create schema if not exists fp;

-- -----------------------------------------------------------------------------
-- Roles
--
-- Two roles, and the separation is the whole security property. `mohar_app` can
-- append to the ledger and read it. It cannot rewrite history even with full
-- application compromise, a SQL injection, or a malicious operator holding the
-- application's credentials — because the grant does not exist.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mohar_app') then
    create role mohar_app login password 'change_me_in_deployment';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mohar_readonly') then
    create role mohar_readonly login password 'change_me_in_deployment';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Reference data (mutable — what was *planned*)
-- -----------------------------------------------------------------------------

create table ref.authority (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null unique,
  created_at    timestamptz not null default now()
);

create table ref.exam (
  id             uuid primary key default gen_random_uuid(),
  authority_id   uuid        not null references ref.authority(id),
  name           text        not null,
  mode           text        not null check (mode in ('digital', 'escorted')),
  starts_at      timestamptz not null,

  -- drand quicknet round the timelock share is bound to. Pinned at sealing time
  -- so a later clock change cannot retarget an already-sealed package.
  drand_round    bigint      not null check (drand_round > 0),

  -- Feeds the throughput ceiling in docs/06. `sides_per_copy` x centre capacity
  -- decides whether digital mode is physically possible at a given centre.
  sides_per_copy int         not null check (sides_per_copy > 0),

  suspended_at   timestamptz,          -- control-room kill switch
  created_at     timestamptz not null default now()
);

create table ref.centre (
  id            uuid primary key default gen_random_uuid(),
  exam_id       uuid        not null references ref.exam(id),
  code          text        not null,

  -- Plain lat/lon rather than PostGIS geography. Geofencing here is a single
  -- point-to-point distance against a radius of ~150 m; the haversine function
  -- below covers it exactly, and avoiding the extension keeps deployment to a
  -- stock Postgres container.
  lat           double precision not null check (lat between -90 and 90),
  lon           double precision not null check (lon between -180 and 180),
  geofence_m    int         not null default 150 check (geofence_m > 0),

  capacity      int         not null check (capacity > 0),
  printers      int         not null default 0 check (printers >= 0),
  has_genset    boolean     not null default false,
  accredited_at timestamptz,

  unique (exam_id, code)
);

create table ref.person (
  id            uuid primary key default gen_random_uuid(),
  display_name  text        not null,
  role          text        not null check (role in
                  ('superintendent','observer','custodian','courier',
                   'district_officer','control_room')),
  -- Hashed, never raw. DPDP minimisation — see docs/08-compliance.md.
  govt_id_hash  bytea       not null,
  webauthn_cred jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create table ref.roster (
  exam_id    uuid not null references ref.exam(id),
  centre_id  uuid not null references ref.centre(id),
  person_id  uuid not null references ref.person(id),
  valid_from timestamptz not null,
  valid_to   timestamptz not null,
  primary key (exam_id, centre_id, person_id),
  check (valid_to > valid_from)
);

create table ref.device (
  id            uuid primary key default gen_random_uuid(),
  kind          text        not null check (kind in ('field','centre_pc','monitor','service')),
  -- Ed25519 public key, 32 bytes. Signature verification key for this device.
  pubkey        bytea       not null unique check (octet_length(pubkey) = 32),
  -- Android Keystore attestation chain / TPM quote. Null for service keys.
  attestation   bytea,
  centre_id     uuid        references ref.centre(id),
  enrolled_at   timestamptz not null default now(),
  revoked_at    timestamptz
);

create table ref.package (
  id            uuid primary key default gen_random_uuid(),
  exam_id       uuid        not null references ref.exam(id),
  centre_id     uuid        not null references ref.centre(id),
  seal_serial   text,                       -- numbered one-time plastic seal
  ciphertext_uri text,                      -- digital mode only
  copies        int         not null check (copies > 0),
  state         text        not null default 'sealed' check (state in
                  ('sealed','in_transit','at_custodian','at_centre',
                   'opened','returned','compromised')),
  custody_from  timestamptz,                -- authorised handling window
  custody_to    timestamptz,
  updated_at    timestamptz not null default now(),
  unique (exam_id, centre_id)
);

create index on ref.roster (person_id);
create index on ref.centre (exam_id);
create index on ref.package (exam_id, state);
create index on ref.device (centre_id) where revoked_at is null;

-- -----------------------------------------------------------------------------
-- Ledger (append-only — what actually *happened*)
-- -----------------------------------------------------------------------------

create table led.event (
  seq            bigserial primary key,

  -- Client-generated; also the idempotency key for offline replay. A field app
  -- that retries a queued event after a flaky sync must not create a duplicate.
  id             uuid        not null unique,

  exam_id        uuid        not null,
  package_id     uuid,
  centre_id      uuid,
  kind           text        not null,

  occurred_at    timestamptz not null,      -- device clock; may be wrong
  received_at    timestamptz not null default now(),
  -- occurred_at − received_at. Recorded, never silently corrected: a large skew
  -- is itself a finding, and correcting it would destroy the evidence.
  clock_skew_ms  bigint      not null,

  actor_person   uuid        references ref.person(id),
  actor_device   uuid        not null references ref.device(id),

  lat            double precision check (lat between -90 and 90),
  lon            double precision check (lon between -180 and 180),
  geo_accuracy_m double precision check (geo_accuracy_m >= 0),

  -- The exact signed body, stored verbatim. Signature verification recomputes
  -- RFC 8785 canonical bytes from this, so it must survive the round-trip
  -- unaltered — which is precisely why key order must not matter.
  body           jsonb       not null,

  device_sig     bytea       not null check (octet_length(device_sig) = 64),
  cosign_device  uuid        references ref.device(id),
  cosign_sig     bytea       check (cosign_sig is null or octet_length(cosign_sig) = 64),

  body_hash      bytea       not null check (octet_length(body_hash) = 32),
  prev_hash      bytea       not null check (octet_length(prev_hash) = 32),
  hash           bytea       not null unique check (octet_length(hash) = 32),

  -- A cosigned event must carry both the device and the signature, or neither.
  constraint cosign_complete check (
    (cosign_device is null and cosign_sig is null) or
    (cosign_device is not null and cosign_sig is not null)
  )
);

create index on led.event (exam_id, seq);
create index on led.event (package_id, seq) where package_id is not null;
create index on led.event (centre_id, seq) where centre_id is not null;
create index on led.event (kind, seq);
create index on led.event (received_at);
create index on led.event (actor_device, seq);
-- Denials and overrides are queried far out of proportion to their volume:
-- they are the state-wide sweep in docs/10 (I1–I3).
create index on led.event (seq) where kind in ('ACCESS_DENIED','OVERRIDE_USED','SEAL_MISMATCH','MONITOR_SILENT');

-- Nightly notarisation. One row per UTC day.
create table led.anchor (
  day          date        primary key,
  merkle_root  bytea       not null check (octet_length(merkle_root) = 32),
  first_seq    bigint      not null,
  last_seq     bigint      not null,
  tree_size    int         not null check (tree_size > 0),
  -- RFC 3161 TimeStampResp from a free TSA. Null until notarisation succeeds;
  -- a TSA outage delays the token without blocking or corrupting the chain.
  tsa_token    bytea,
  tsa_attempts int         not null default 0,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  check (last_seq >= first_seq)
);

-- -----------------------------------------------------------------------------
-- Append-only enforcement
--
-- Belt and braces. The grants below are the real control; this trigger catches
-- anything running as a superuser or a misconfigured role and makes the failure
-- loud instead of silent.
-- -----------------------------------------------------------------------------

create or replace function led.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception
    'led.% is append-only: % is not permitted (attempted by %)',
    tg_table_name, tg_op, current_user
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger event_no_update before update on led.event
  for each statement execute function led.reject_mutation();
create trigger event_no_delete before delete on led.event
  for each statement execute function led.reject_mutation();
create trigger event_no_truncate before truncate on led.event
  for each statement execute function led.reject_mutation();

-- -----------------------------------------------------------------------------
-- Fingerprint records
-- -----------------------------------------------------------------------------

create table fp.copy (
  id                uuid primary key default gen_random_uuid(),
  package_id        uuid        not null references ref.package(id),
  seat_label        text,                    -- null when per-centre only
  serial            text        not null unique,
  -- Block-constrained permutation. Permuting only within difficulty-matched
  -- blocks is what makes the fairness defence in docs/10 possible.
  permutation       jsonb       not null,
  watermark_payload bytea       not null,
  answer_key        jsonb       not null,
  created_at        timestamptz not null default now()
);

create table fp.attribution (
  id            uuid primary key default gen_random_uuid(),
  image_sha256  bytea       not null check (octet_length(image_sha256) = 32),
  matched_copy  uuid        references fp.copy(id),
  -- Never rounded to a boolean "match". An attribution that cannot be defended
  -- under cross-examination is worse than no attribution.
  confidence    numeric(4,3) not null check (confidence between 0 and 1),
  channels      text[]      not null,        -- permutation | watermark | serial
  report_sig    bytea       not null,
  created_at    timestamptz not null default now()
);

create index on fp.copy (package_id);
create index on fp.attribution (matched_copy);

-- -----------------------------------------------------------------------------
-- Geo helper — haversine great-circle distance in metres.
-- -----------------------------------------------------------------------------

create or replace function ref.distance_m(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language sql immutable parallel safe as $$
  select 6371000.0 * 2 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) *
      power(sin(radians(lon2 - lon1) / 2), 2)
  ));
$$;

-- -----------------------------------------------------------------------------
-- Grants — the actual append-only control
-- -----------------------------------------------------------------------------

grant usage on schema ref, led, fp to mohar_app, mohar_readonly;

grant select, insert, update, delete on all tables in schema ref to mohar_app;
grant select, insert, update, delete on all tables in schema fp  to mohar_app;

-- The ledger: INSERT and SELECT only. No UPDATE. No DELETE. Not an oversight.
grant select, insert on led.event  to mohar_app;
grant select, insert, update on led.anchor to mohar_app;  -- tsa_token filled in after
grant usage, select on all sequences in schema led to mohar_app;
grant usage, select on all sequences in schema ref to mohar_app;
grant usage, select on all sequences in schema fp  to mohar_app;

grant select on all tables in schema ref, led, fp to mohar_readonly;

commit;
