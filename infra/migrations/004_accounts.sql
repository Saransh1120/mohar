-- -----------------------------------------------------------------------------
-- 004 — Operator accounts and sessions.
--
-- The gateway service (docs/02) is still empty, so until it exists the ledger
-- owns the one thing the control room genuinely cannot work without: knowing
-- who is looking at it. This is a real credential store, not a stand-in — the
-- password is never stored, only a scrypt hash of it, and a session is a random
-- 256-bit token of which we keep only the SHA-256.
--
-- It does NOT make the ledger API safe to expose publicly. Device enrolment and
-- event append are still unauthenticated (see registry-routes.ts); this covers
-- the human-facing control room only. Bind to localhost until `gateway` lands.
-- -----------------------------------------------------------------------------

begin;

create table ref.account (
  id             uuid        primary key default gen_random_uuid(),
  username       text        not null check (length(username) between 3 and 64),

  -- scrypt(password, salt) — 64 bytes. Parameters are stored per row so they can
  -- be raised later without invalidating credentials issued under the old cost:
  -- a row verifies against the parameters it was written with, and is rewritten
  -- at the next successful sign-in.
  password_hash  bytea       not null check (octet_length(password_hash) = 64),
  password_salt  bytea       not null check (octet_length(password_salt) = 16),
  scrypt_n       int         not null default 16384,
  scrypt_r       int         not null default 8,
  scrypt_p       int         not null default 1,

  -- Which control-room role this account acts as. Same vocabulary as ref.person
  -- so an account can later be tied to a real person on the roster.
  role           text        not null default 'control_room' check (role in
                   ('superintendent','observer','custodian','courier',
                    'district_officer','control_room')),
  person_id      uuid        references ref.person(id),

  display_name   text        not null,
  created_at     timestamptz not null default now(),
  last_sign_in   timestamptz,
  disabled_at    timestamptz,
  disabled_reason text
);

-- Usernames are compared case-insensitively. Two accounts differing only by
-- capitalisation is an impersonation vector, not a feature.
create unique index account_username_lower on ref.account (lower(username));

create table ref.session (
  -- SHA-256 of the bearer token. The token itself is shown to the browser once
  -- and never stored, exactly as the custody keys are handled in 002.
  token_hash   bytea       primary key check (octet_length(token_hash) = 32),
  account_id   uuid        not null references ref.account(id) on delete cascade,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  -- Set on sign-out. Rows are kept rather than deleted so "this session ended
  -- at 21:04" remains answerable.
  revoked_at   timestamptz,
  user_agent   text,
  check (expires_at > issued_at)
);

create index session_account on ref.session (account_id, issued_at desc);
create index session_expiry  on ref.session (expires_at) where revoked_at is null;

grant select, insert, update on ref.account to mohar_app;
grant select, insert, update on ref.session to mohar_app;
-- The read-only role is for auditors and dashboards; it has no business seeing
-- password material, so it gets columns rather than tables.
grant select (id, username, role, person_id, display_name,
              created_at, last_sign_in, disabled_at, disabled_reason)
  on ref.account to mohar_readonly;
grant select (account_id, issued_at, expires_at, last_seen_at, revoked_at, user_agent)
  on ref.session to mohar_readonly;

commit;
