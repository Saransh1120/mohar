-- Run as mohar_migrator.

-- ── an operator's passkey ───────────────────────────────────────────────────
--
-- Until now an account signed in with a password and nothing else. A courier's
-- hand-off already needs a WebAuthn credential (016); the operator who approves
-- overrides and issues keys needed less than the courier did.
--
-- An account may now hold passkeys. Once it holds one, its password alone no
-- longer opens a session: the password gets a challenge, and a passkey has to
-- sign it. An account with none signs in as before, so this is taken up one
-- account at a time and locks nobody out by being applied.
--
-- A passkey is never deleted. Removing one sets removed_at, so "this account
-- could be opened with that key until 14:02" stays answerable.

create table ref.account_passkey (
  id             uuid        primary key default gen_random_uuid(),
  account_id     uuid        not null references ref.account(id),
  credential_id  text        not null,
  public_key     bytea       not null,
  -- The authenticator's signature counter as last seen. Many platform
  -- authenticators always report 0; where one counts, going backwards is refused.
  counter        bigint      not null default 0 check (counter >= 0),
  transports     text[],
  label          text        check (label is null or length(label) <= 80),
  added_at       timestamptz not null default now(),
  last_used_at   timestamptz,
  removed_at     timestamptz,
  removed_by     uuid        references ref.account(id)
);

create index account_passkey_account_idx on ref.account_passkey (account_id) where removed_at is null;
-- One live enrolment per authenticator. A removed one can be enrolled again.
create unique index account_passkey_credential_idx on ref.account_passkey (credential_id) where removed_at is null;

-- Challenges are short-lived and one-use, like 016's. Kept apart from that
-- table because those belong to a person on a roster and these to an account.
create table ref.account_challenge (
  id           uuid        primary key default gen_random_uuid(),
  purpose      text        not null check (purpose in ('register', 'signin')),
  account_id   uuid        not null references ref.account(id),
  challenge    text        not null unique,
  user_agent   text,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  check (expires_at > issued_at)
);

create index account_challenge_account_idx on ref.account_challenge (account_id, issued_at desc);

grant select, insert, update on ref.account_passkey, ref.account_challenge to mohar_app;
grant select on ref.account_passkey to mohar_readonly;
