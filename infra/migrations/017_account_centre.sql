-- Run as mohar_migrator.

-- ── an account limited to named centres ─────────────────────────────────────
--
-- Until now a role decided what an account could change and nothing decided
-- what it could see: any signed-in account read every packet, every hand-off
-- and every alert of every centre.
--
-- A row here limits an account to that centre. An account with one or more
-- rows sees only those centres' packets, hand-offs and alerts, and nothing
-- else; it changes nothing. An account with no row is as it was. So this is a
-- limit that is put on, not a permission that has to be granted before anyone
-- can work, and a deployment that never uses it behaves exactly as before.
--
-- Rows are reference data and can be removed: who is limited to what is a
-- present arrangement. Each change is also raised as an alert, which cannot be.

create table ref.account_centre (
  account_id  uuid        not null references ref.account(id),
  centre_id   uuid        not null references ref.centre(id),
  granted_by  uuid        references ref.account(id),
  granted_at  timestamptz not null default now(),
  primary key (account_id, centre_id)
);

create index account_centre_centre_idx on ref.account_centre (centre_id);

grant select, insert, delete on ref.account_centre to mohar_app;
grant select on ref.account_centre to mohar_readonly;
