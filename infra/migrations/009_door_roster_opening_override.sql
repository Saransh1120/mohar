-- 009 · the strong room door, the opening key, and the damaged-label override
--
-- 006 made the tables that hold what happened in a strong room and at an
-- opening. This adds what the engines for them need around those tables: the
-- rooms themselves, a record of every attempt at the door (refused ones
-- included), the commitments an opening key is checked against, the key a
-- station unwraps its shares with, and the request and decision rows of the
-- override for a label that will not scan.
--
-- Run as mohar_migrator.

-- ── strong rooms ────────────────────────────────────────────────────────────

create table ref.strong_room (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  place             text        not null,
  centre_id         uuid        references ref.centre(id),
  -- The room monitor on this door. Footfall and the heartbeat are read from the
  -- chain events this device signs, not from what an entry request claims.
  monitor_device_id uuid        references ref.device(id),
  created_at        timestamptz not null default now()
);

-- Every attempt to enter or leave, written before the answer. led.strongroom_visit
-- holds only the entries that were allowed; one person trying the door alone at
-- 03:00 is refused, and that refusal is the row worth having.
create table led.strongroom_attempt (
  id           uuid        primary key default gen_random_uuid(),
  -- No foreign key: an attempt naming a room that does not exist is still an
  -- attempt, and a constraint would throw it away.
  room_id      uuid        not null,
  device_id    uuid        references ref.device(id),
  kind         text        not null check (kind in ('entry', 'exit')),
  -- Who presented: person, slot, score, whether the face matched. Never an
  -- image and never a template.
  persons      jsonb       not null,
  checks       jsonb       not null,
  outcome      text        not null check (outcome in ('granted', 'refused')),
  visit_id     uuid        references led.strongroom_visit(id),
  recorded_at  timestamptz not null default now()
);

create index strongroom_attempt_room_idx on led.strongroom_attempt (room_id, recorded_at desc);

-- ── the key a station unwraps with ──────────────────────────────────────────
--
-- A device's enrolled key signs. Unwrapping a share needs a key-agreement key,
-- which is a different key on purpose: the one that signs records is never the
-- one that opens secrets. Only the public half is here.

create table ref.device_wrap_key (
  device_id      uuid        primary key references ref.device(id),
  x25519_pub     bytea       not null check (octet_length(x25519_pub) = 32),
  registered_at  timestamptz not null default now()
);

-- ── the opening key, as commitments ─────────────────────────────────────────
--
-- Written when the duty roster is locked. The key itself, the control room's
-- part and the officials' shares are generated, wrapped into led.share_envelope
-- and dropped in the same request; what stays readable here is only what lets a
-- later reconstruction be checked. Nothing in this row opens anything.

create table led.opening_key (
  package_id         uuid        primary key references ref.package(id),
  key_commitment     char(64)    not null check (key_commitment ~ '^[0-9a-f]{64}$'),
  control_commitment char(64)    not null check (control_commitment ~ '^[0-9a-f]{64}$'),
  -- [{ holder, institution, index, commitment, personId }]
  field_shares       jsonb       not null,
  drand_round        bigint      not null check (drand_round > 0),
  scheduled_open_at  timestamptz not null,
  station_device_id  uuid        not null references ref.device(id),
  exam_session       text        not null,
  issued_at          timestamptz not null default now()
);

-- ── the damaged-label override ──────────────────────────────────────────────
--
-- A request is what the field reported: which leg, who, the seam id typed off
-- the label, the hash of the photograph. A decision is one operator's answer.
-- Two operators must approve, so approval is two rows from two accounts, and a
-- refusal from either is a row as well. Nothing is updated.

create table led.seam_override_request (
  id                uuid        primary key default gen_random_uuid(),
  leg_id            uuid        not null references ref.route_leg(id),
  package_id        uuid        not null references ref.package(id),
  person_id         uuid        references ref.person(id),
  device_id         uuid        references ref.device(id),
  seam_id_typed     text        not null,
  serial_typed      text,
  -- How long the app tried to decode before giving up. The procedure says 10 s.
  attempted_seconds integer     not null check (attempted_seconds > 0),
  which_codes       text        not null check (which_codes in ('A', 'B', 'both')),
  photo_sha256      char(64)    not null check (photo_sha256 ~ '^[0-9a-f]{64}$'),
  -- What the engine found when it compared the typed values with the record.
  evidence          jsonb       not null,
  requested_at      timestamptz not null default now()
);

create index seam_override_request_leg_idx on led.seam_override_request (leg_id, requested_at desc);

create table led.seam_override_decision (
  id                uuid        primary key default gen_random_uuid(),
  request_id        uuid        not null references led.seam_override_request(id),
  account_id        uuid        not null references ref.account(id),
  decision          text        not null check (decision in ('approved', 'refused')),
  -- What the operator states they saw. The system cannot see a video call; it
  -- records that a named operator said so.
  video_confirmed   boolean     not null,
  officers_present  boolean     not null,
  note              text        not null,
  decided_at        timestamptz not null default now(),
  -- One answer per operator per request. A second approval has to come from a
  -- second account, which is what makes it a two-person rule.
  unique (request_id, account_id)
);

-- ── grants ──────────────────────────────────────────────────────────────────

grant select, insert, update, delete on ref.strong_room, ref.device_wrap_key to mohar_app;

grant select, insert on
  led.strongroom_attempt, led.opening_key,
  led.seam_override_request, led.seam_override_decision
  to mohar_app;

grant select on
  ref.strong_room, ref.device_wrap_key,
  led.strongroom_attempt, led.opening_key,
  led.seam_override_request, led.seam_override_decision
  to mohar_readonly;

-- ── who may be enrolled on a reader ─────────────────────────────────────────
--
-- 003 allowed a finger to be registered only as a superintendent or an
-- observer, the two roles the unlock ceremony knew about. The strong room door
-- is opened by custodians and officers, and the third official at an opening is
-- the police escort, so the register has to be able to name them.

alter table ref.fingerprint_enrolment
  drop constraint if exists fingerprint_enrolment_role_check;

alter table ref.fingerprint_enrolment
  add constraint fingerprint_enrolment_role_check check (role in
    ('superintendent','observer','police_escort','custodian','courier',
     'press_operator','district_officer','enrolling_officer','control_room'));
