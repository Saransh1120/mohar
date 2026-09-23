-- 006 · hand-off legs, the strong room, the opening ceremony and alerts
--
-- Everything the build spec's transfer and ceremony stages need to record what
-- they observed. Reference data (`ref.*`) describes the plan and may be edited;
-- ledger data (`led.*`) describes what happened and may not. mohar_app gets
-- SELECT and INSERT on every new led.* table and nothing else, which is the
-- same append-only guarantee 001 established and the ledger checks at boot.
--
-- Run as mohar_migrator.

-- ── roles the spec names ────────────────────────────────────────────────────
--
-- The press operator seals packets, the police escort holds one of the three
-- field shares, and enrolling officers run the district biometric ceremony in
-- pairs. The board observer stays 'observer' and the control room operator
-- stays 'control_room': the person and the authority are never separated in a
-- decision, so a second name for either would only create two ways to write
-- the same row.

alter table ref.person
  drop constraint if exists person_role_check;

alter table ref.person
  add constraint person_role_check check (role in
    ('superintendent','observer','police_escort','custodian','courier',
     'press_operator','district_officer','enrolling_officer','control_room'));

-- ── the printed label ───────────────────────────────────────────────────────

create table ref.seal_label (
  package_id        uuid        primary key references ref.package(id),
  -- Opaque handle printed on the label and encoded in both QR codes. Not the
  -- serial and not sequential: a seam id must reveal nothing about which packet
  -- it belongs to or how many were printed that day.
  seam_id           text        not null unique,
  -- sha256("MOHAR-SEAM-v1" || seamId || seamSecret). The secret itself lives on
  -- the label and nowhere else, so reading this table reveals no way to satisfy
  -- a seal check.
  commitment_hex    char(64)    not null check (commitment_hex ~ '^[0-9a-f]{64}$'),
  -- One label, or two identical ones on opposite flaps. Both carry the same
  -- secret; the second is redundancy against a torn label, not a second factor.
  labels_per_packet smallint    not null default 1 check (labels_per_packet in (1, 2)),
  created_at        timestamptz not null default now()
);

comment on table ref.seal_label is
  'One label set per packet. The seam secret is never stored - only its commitment.';

-- ── the planned journey ─────────────────────────────────────────────────────
--
-- Legs are planned before the packet moves, which is what makes lateness
-- detectable: a leg with no expected_by can be late forever without anyone
-- being able to say so.

create table ref.route_leg (
  id            uuid        primary key default gen_random_uuid(),
  package_id    uuid        not null references ref.package(id),
  leg_no        smallint    not null check (leg_no > 0),
  from_role     text        not null,
  to_role       text        not null,
  from_place    text        not null,
  to_place      text        not null,
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  -- When this leg should have closed. The watchdog raises LEG_OVERDUE past it.
  expected_by   timestamptz not null,
  -- Centre of the permitted corridor and its radius, in the same shape the
  -- access engine already uses for a centre geofence.
  geo_lat       double precision,
  geo_lon       double precision,
  geo_radius_m  integer     check (geo_radius_m is null or geo_radius_m > 0),
  created_at    timestamptz not null default now(),
  unique (package_id, leg_no),
  check (window_end > window_start),
  check (expected_by >= window_start)
);

create index route_leg_open_idx on ref.route_leg (expected_by);
create index route_leg_package_idx on ref.route_leg (package_id, leg_no);

-- ── transfer keys ───────────────────────────────────────────────────────────
--
-- Issued at dispatch, released to the receiver's device only after every check
-- passes, and never shown to the sender. Only the hash is stored: a database
-- read must not hand anyone the means to complete a hand-off.

create table led.transfer_key (
  leg_id         uuid        primary key references ref.route_leg(id),
  -- sha256(transferKey || seamId || legId). Binding the key to the leg means a
  -- key overheard on one hand-off cannot be replayed on the next.
  key_hash_hex   char(64)    not null check (key_hash_hex ~ '^[0-9a-f]{64}$'),
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  issued_event_id uuid       not null,
  check (expires_at > issued_at)
);

comment on table led.transfer_key is
  'Hash only. The key exists on the receiver device for the length of one leg.';

-- ── every attempt to accept a packet ────────────────────────────────────────
--
-- Recorded before the answer is returned, including attempts naming a leg or a
-- person that does not exist: a request that probes for a valid leg id is
-- exactly what this table is for, and a foreign key would throw it away.

create table led.transfer_attempt (
  id            uuid        primary key default gen_random_uuid(),
  leg_id        uuid        references ref.route_leg(id),
  person_id     uuid        references ref.person(id),
  device_id     uuid        references ref.device(id),
  -- What was typed or scanned, before any lookup.
  seam_id_seen  text,
  serial_typed  text,
  -- One object per check: name, passed, evidence, reason. The verdict without
  -- its inputs cannot be re-examined months later in front of a magistrate.
  checks        jsonb       not null,
  outcome       text        not null check (outcome in ('granted','refused')),
  attempt_no    smallint    not null check (attempt_no > 0),
  recorded_at   timestamptz not null default now()
);

create index transfer_attempt_leg_idx on led.transfer_attempt (leg_id, recorded_at desc);
create index transfer_attempt_refused_idx on led.transfer_attempt (recorded_at desc)
  where outcome = 'refused';

-- ── the duty roster, locked a day ahead ─────────────────────────────────────

create table ref.duty_roster (
  id           uuid        primary key default gen_random_uuid(),
  centre_id    uuid        not null references ref.centre(id),
  exam_session text        not null,
  role         text        not null,
  person_id    uuid        not null references ref.person(id),
  -- Null until the roster is locked at T-24h. Shares are re-wrapped to named
  -- officers only after this is set, so an unlocked roster cannot leak a share
  -- to whoever happens to be listed at the time.
  locked_at    timestamptz,
  created_at   timestamptz not null default now(),
  unique (centre_id, exam_session, role)
);

-- ── wrapped shares and control envelopes ────────────────────────────────────
--
-- Ciphertext only. A row here is useless without the holder's device key, or,
-- for the control part, without a drand round that has not been published yet.

create table led.share_envelope (
  id           uuid        primary key default gen_random_uuid(),
  package_id   uuid        not null references ref.package(id),
  kind         text        not null check (kind in
                 ('field_role','field_person','control_timelock')),
  -- Role name for a role-bound share, person id for a re-wrapped one, station
  -- device id for a control envelope. Text because the three are not the same
  -- kind of thing and a union column that lies about its type is worse.
  holder       text        not null,
  ciphertext   text        not null,
  ciphertext_sha256 char(64) not null check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  -- Only for control_timelock rows: the round that opens the envelope.
  drand_round  bigint      check (drand_round is null or drand_round > 0),
  policy_sha256 char(64)   check (policy_sha256 is null or policy_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at    timestamptz not null default now(),
  check (kind <> 'control_timelock' or drand_round is not null)
);

create index share_envelope_package_idx on led.share_envelope (package_id, kind);

-- ── the opening ceremony ────────────────────────────────────────────────────

create table led.ceremony (
  id           uuid        primary key default gen_random_uuid(),
  package_id   uuid        not null references ref.package(id),
  -- Which path this ceremony is running. 'envelope-authorized' means the
  -- station has no network and is opening from its cached timelock envelope;
  -- that is evidence about the conditions, not a lesser outcome.
  mode         text        not null check (mode in ('live-authorized','envelope-authorized')),
  centre_id    uuid        not null references ref.centre(id),
  scheduled_open_at timestamptz not null,
  started_at   timestamptz not null default now()
);

create index ceremony_package_idx on led.ceremony (package_id, started_at desc);

-- Each step of the ceremony is its own row. The ceremony's state is the latest
-- step, derived rather than stored, because a status column would have to be
-- updated and led.* is append-only. It also keeps the abandoned attempts: a
-- ceremony that reached 'identify' twice and never released is the shape of an
-- evening someone will be asked about.

create table led.ceremony_step (
  id           uuid        primary key default gen_random_uuid(),
  ceremony_id  uuid        not null references led.ceremony(id),
  step         text        not null check (step in
                 ('scan','authorize','identify','confirm','release','opened','incomplete')),
  outcome      text        not null check (outcome in ('passed','refused')),
  -- The officials who contributed at this step: role, institution, slot, score.
  -- Never share material and never a fingerprint template.
  officials    jsonb       not null default '[]'::jsonb,
  photo_sha256 char(64)    check (photo_sha256 is null or photo_sha256 ~ '^[0-9a-f]{64}$'),
  evidence     jsonb       not null,
  recorded_at  timestamptz not null default now()
);

create index ceremony_step_idx on led.ceremony_step (ceremony_id, recorded_at);

-- ── strong room visits ──────────────────────────────────────────────────────

create table led.strongroom_visit (
  id              uuid        primary key default gen_random_uuid(),
  room_id         uuid        not null,
  -- Both entrants: who verified, on which slot, and whether the face matched.
  persons         jsonb       not null,
  entered_at      timestamptz not null,
  -- What the task is expected to take. Dwell is judged against this rather than
  -- against an average, because collecting one packet and conducting an audit
  -- are both legitimate and take very different times.
  expected_minutes integer    not null check (expected_minutes > 0),
  footfall_in     jsonb
);

create index strongroom_visit_open_idx on led.strongroom_visit (room_id, entered_at desc);

-- The exit is a second row rather than a column set on the first, because
-- led.* takes no UPDATE. A visit with no exit row is a person still inside, or
-- a monitor that stopped reporting - and both of those need to be visible
-- rather than indistinguishable from a tidy record.

create table led.strongroom_exit (
  id               uuid        primary key default gen_random_uuid(),
  visit_id         uuid        not null unique references led.strongroom_visit(id),
  exited_at        timestamptz not null,
  dwell_seconds    integer     not null check (dwell_seconds >= 0),
  packages_touched integer     not null default 0 check (packages_touched >= 0),
  footfall_out     jsonb
);

-- ── alerts ──────────────────────────────────────────────────────────────────
--
-- Append-only, like everything else in led. An acknowledgement is a new row in
-- led.alert_ack rather than a column set on the alert, so "who knew, and when"
-- survives as a record instead of being overwritten by whoever looked last.
--
-- There is no severity column, deliberately. An alert states what happened and
-- what is known; ranking it critical or medium invites a control room to learn
-- which colour it may ignore.

create table led.alert (
  id            uuid        primary key default gen_random_uuid(),
  kind          text        not null,
  package_id    uuid        references ref.package(id),
  leg_id        uuid        references ref.route_leg(id),
  centre_id     uuid        references ref.centre(id),
  device_id     uuid        references ref.device(id),
  evidence      jsonb       not null,
  -- Whether a person has to decide something, and what follows if nobody does.
  requires_decision boolean not null default false,
  consequence   text        not null,
  raised_at     timestamptz not null default now()
);

create index alert_open_idx on led.alert (raised_at desc);
create index alert_package_idx on led.alert (package_id, raised_at desc);

create table led.alert_ack (
  id         uuid        primary key default gen_random_uuid(),
  alert_id   uuid        not null references led.alert(id),
  person_id  uuid        not null references ref.person(id),
  note       text,
  acked_at   timestamptz not null default now()
);

create index alert_ack_alert_idx on led.alert_ack (alert_id, acked_at desc);

-- ── grants ──────────────────────────────────────────────────────────────────
--
-- led.* gets SELECT and INSERT for the app and nothing else: no UPDATE, no
-- DELETE, on any of these tables. led.strongroom_visit and led.ceremony need a
-- settle time written after the fact, and they get it by inserting a second row
-- rather than by updating the first - the same discipline as led.alert_ack.

grant select, insert on
  led.transfer_key, led.transfer_attempt, led.share_envelope,
  led.ceremony, led.ceremony_step, led.strongroom_visit, led.strongroom_exit,
  led.alert, led.alert_ack
  to mohar_app;

grant select, insert, update, delete on ref.seal_label, ref.route_leg, ref.duty_roster
  to mohar_app;

grant select on
  led.transfer_key, led.transfer_attempt, led.share_envelope,
  led.ceremony, led.ceremony_step, led.strongroom_visit, led.strongroom_exit,
  led.alert, led.alert_ack,
  ref.seal_label, ref.route_leg, ref.duty_roster
  to mohar_readonly;

grant usage, select on all sequences in schema led to mohar_app;
grant usage, select on all sequences in schema ref to mohar_app;
