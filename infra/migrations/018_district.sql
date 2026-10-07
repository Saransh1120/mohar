-- Run as mohar_migrator.

-- ── districts ───────────────────────────────────────────────────────────────
--
-- 017 lets an account be limited to named centres. A district officer answers
-- for a district, and naming its centres one by one goes stale the day a centre
-- is added. So a centre can say which district it is in, and an account can be
-- limited to a district: it then sees whichever centres are in that district
-- at the moment it asks.
--
-- A district is a name, not a table of its own. Nothing else hangs off it yet,
-- and a register of districts that nobody keeps would be a second place for
-- the same word to be spelled differently. Names are compared without regard
-- to case.

alter table ref.centre
  add column district text check (district is null or length(btrim(district)) between 2 and 80);

create index centre_district_idx on ref.centre (lower(district)) where district is not null;

create table ref.account_district (
  account_id  uuid        not null references ref.account(id),
  district    text        not null check (length(btrim(district)) between 2 and 80),
  granted_by  uuid        references ref.account(id),
  granted_at  timestamptz not null default now(),
  primary key (account_id, district)
);

grant select, insert, delete on ref.account_district to mohar_app;
grant select on ref.account_district to mohar_readonly;
