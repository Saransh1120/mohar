-- =============================================================================
-- 002_custody_keys — time-bounded custody access keys, and a forensic record of
-- every attempt to use one.
--
-- The problem this solves: until now, "authority X accessed the package at
-- stage Y" was an assertion by whoever wrote the event. There was nothing to
-- present, nothing to verify, and nothing that expired. A key that never
-- rotates is a key that is valid forever once photographed.
--
-- Every stage of custody now requires a stage-specific key that is valid for a
-- six-hour epoch and no longer. A key copied at 02:00 stops working by 06:00.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Stages of authority access.
--
-- These are the points at which a human takes responsibility for the package.
-- Each needs its own key so that a courier's key cannot open a package and a
-- superintendent's key cannot re-route one in transit.
-- -----------------------------------------------------------------------------
create table led.custody_stage (
  stage        text primary key,
  ordinal      int  not null unique,
  description  text not null,
  -- The role expected to hold this stage's key. Enforced as a check at issue
  -- time, recorded on every attempt so a role mismatch is visible afterwards.
  expected_role text not null
);

insert into led.custody_stage (stage, ordinal, description, expected_role) values
  ('seal',      1, 'Authority seals the bundle and registers the seal serial',  'district_officer'),
  ('dispatch',  2, 'Package released from the authority to a courier',          'district_officer'),
  ('transit',   3, 'Courier holds the package on the road',                     'courier'),
  ('custodian', 4, 'Package held in a custodian''s strongroom',                 'custodian'),
  ('centre',    5, 'Package received at the examination centre',                'superintendent'),
  ('unlock',    6, 'Package opened for printing — the highest-value stage',     'superintendent'),
  ('print',     7, 'Metered printing under way',                               'superintendent'),
  ('destroy',   8, 'Content key zeroisation confirmed',                        'superintendent');

-- -----------------------------------------------------------------------------
-- Issued keys.
--
-- The key itself is NEVER stored. We keep a SHA-256 of it, exactly as a password
-- would be handled: the holder is shown the key once at issue time and we can
-- verify a presentation afterwards, but a database dump yields nothing usable.
--
-- `epoch` is floor(unix_seconds / 21600) — a six-hour bucket. Rotation is
-- therefore not a background job that might fail to run; it is arithmetic on the
-- clock, and a key for a past epoch simply has no window in which it verifies.
-- -----------------------------------------------------------------------------
create table led.access_key (
  id             uuid primary key default gen_random_uuid(),
  package_id     uuid        not null references ref.package(id),
  stage          text        not null references led.custody_stage(stage),
  epoch          bigint      not null check (epoch > 0),

  key_hash       bytea       not null check (octet_length(key_hash) = 32),
  -- First bytes of the hash, in the clear. Safe to log and print: it identifies
  -- which key was used without being usable to authenticate.
  fingerprint    text        not null,

  issued_to_person uuid      references ref.person(id),
  issued_to_role   text      not null,
  issued_at      timestamptz not null default now(),
  valid_from     timestamptz not null,
  valid_to       timestamptz not null,

  -- Set when a key is burned early: the holder changed, the package was
  -- compromised, or a key was suspected copied. Never deleted.
  revoked_at     timestamptz,
  revoked_reason text,

  check (valid_to > valid_from),
  unique (package_id, stage, epoch)
);

create index on led.access_key (package_id, stage, epoch desc);
create index on led.access_key (fingerprint);
create index on led.access_key (valid_to) where revoked_at is null;

-- -----------------------------------------------------------------------------
-- Every presentation of a key, accepted or refused.
--
-- Strictly append-only, like led.event: no UPDATE or DELETE grant exists. A
-- refused attempt is the most valuable row in this table — three failures
-- against a package at 02:40 is the signal the whole system exists to surface —
-- so nothing is permitted to prune them.
--
-- This is separate from led.event on purpose. An attempt is not a custody fact
-- until the engine has ruled on it; the ruling is what becomes a signed event.
-- Keeping the raw attempt here means we retain presentations that never became
-- events at all, including ones with a fingerprint matching no key we ever issued.
-- -----------------------------------------------------------------------------
create table led.access_attempt (
  seq            bigserial primary key,
  id             uuid        not null unique default gen_random_uuid(),

  package_id     uuid        references ref.package(id),
  centre_id      uuid        references ref.centre(id),
  exam_id        uuid        references ref.exam(id),
  stage          text        references led.custody_stage(stage),

  -- What was presented. `key_id` resolves only when the fingerprint matched a
  -- key we issued; a null key_id with a non-null fingerprint means someone
  -- presented something we have never seen, which is worth a great deal.
  presented_fingerprint text,
  key_id         uuid        references led.access_key(id),
  key_epoch      bigint,
  current_epoch  bigint      not null,

  actor_device   uuid        references ref.device(id),
  actor_person   uuid        references ref.person(id),
  actor_role     text,

  outcome        text        not null check (outcome in ('granted','denied')),
  -- Every failing check, not just the first. One attempt tripping four checks is
  -- a materially different event from one tripping a clock skew.
  deny_reasons   text[]      not null default '{}',
  checks_passed  text[]      not null default '{}',

  -- Full forensic context, captured at decision time so the record stands alone
  -- even if reference data later changes.
  lat            double precision,
  lon            double precision,
  geo_accuracy_m double precision,
  distance_m     double precision,
  seal_serial_read text,
  clock_skew_ms  bigint,
  device_kind    text,
  session_id     uuid,

  -- The signed event this decision produced, once appended. Null if the
  -- decision was recorded but no event followed.
  event_id       uuid,

  attempted_at   timestamptz not null,
  decided_at     timestamptz not null default now()
);

create index on led.access_attempt (package_id, seq desc);
create index on led.access_attempt (outcome, decided_at desc);
create index on led.access_attempt (presented_fingerprint);
create index on led.access_attempt (seq desc);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Keys: the app issues them and may revoke them, but may not erase the record
-- that one existed.
grant select, insert, update on led.access_key to mohar_app;

-- Attempts: insert and read only. Same rule as led.event, same reason — the
-- forensic value of a refused attempt is exactly that nobody can remove it.
grant select, insert on led.access_attempt to mohar_app;

grant select on led.custody_stage to mohar_app, mohar_readonly;
grant select on led.access_key, led.access_attempt to mohar_readonly;
grant usage, select on all sequences in schema led to mohar_app;

commit;
