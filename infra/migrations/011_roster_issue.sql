-- 011 · a roster can be issued more than once, and each issue is on record
--
-- 009 gave each packet exactly one opening key, made when its centre's roster
-- was locked. Two things were missing.
--
-- An official falls ill the evening before. The roster has to change after it
-- was locked, and the share wrapped for the person who is no longer coming must
-- stop being the one that opens the packet. Nothing readable was kept at the
-- lock, so a single share cannot be re-wrapped: the packet gets a new key, new
-- shares and a new time-locked envelope. That is a second issue for the same
-- packet, which the primary key on led.opening_key did not allow.
--
-- And a lock was not a recorded act. When it happened was a timestamp on a ref
-- row; who did it, how long before the exam, and why it was late if it was,
-- were nowhere. led.roster_issue is that record, one row per lock and per
-- re-issue.
--
-- Nothing is rewritten. An earlier issue's commitments and ciphertext stay as
-- they were; the engine reads the highest issue number, and a key assembled
-- from a superseded issue no longer matches the commitment it is checked
-- against.
--
-- Run as mohar_migrator.

alter table led.opening_key
  add column issue_no smallint not null default 1 check (issue_no > 0);

alter table led.opening_key
  drop constraint opening_key_pkey;

alter table led.opening_key
  add primary key (package_id, issue_no);

-- Which issue a wrapped share or a control envelope belongs to.
alter table led.share_envelope
  add column issue_no smallint not null default 1 check (issue_no > 0);

create index share_envelope_issue_idx on led.share_envelope (package_id, issue_no, kind);

create table led.roster_issue (
  id                 uuid        primary key default gen_random_uuid(),
  centre_id          uuid        not null references ref.centre(id),
  exam_session       text        not null,
  issue_no           smallint    not null check (issue_no > 0),
  kind               text        not null check (kind in ('lock', 'reissue')),
  -- The operator who did it. A lock wraps key material to named officers.
  account_id         uuid        references ref.account(id),
  station_device_id  uuid        not null references ref.device(id),
  -- The three officials as issued: [{ role, personId }]. ref.duty_roster says
  -- who they are now; this says who they were at this issue.
  roster             jsonb       not null,
  -- Who changed, on a re-issue: [{ role, fromPersonId, toPersonId }].
  changes            jsonb       not null default '[]'::jsonb,
  packets            integer     not null check (packets >= 0),
  -- How long before the exam's start this was done. The procedure is a day.
  lead_seconds       integer     not null,
  late               boolean     not null,
  -- Required when late, and always on a re-issue.
  reason             text,
  issued_at          timestamptz not null default now(),
  unique (centre_id, exam_session, issue_no),
  check (not late or reason is not null),
  check (kind <> 'reissue' or reason is not null)
);

create index roster_issue_centre_idx on led.roster_issue (centre_id, exam_session, issue_no desc);

grant select, insert on led.roster_issue to mohar_app;
grant select on led.roster_issue to mohar_readonly;
