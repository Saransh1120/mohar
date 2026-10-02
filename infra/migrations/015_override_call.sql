-- Run as mohar_migrator.

-- ── the video call an override is approved over ─────────────────────────────
--
-- A damaged-label override is approved by two control room operators who each
-- see the packet and both officers on live video. Until now that was the
-- operator's statement and nothing else. The call is now set up through the
-- ledger, between the phone that made the request and each operator's browser,
-- and this table is what the ledger knows about it.
--
-- What it knows is limited and the rows say which kind each is. The media goes
-- phone to browser and never passes through the ledger, so the ledger cannot
-- see the picture. It can record:
--
--   joined / offered / answered   it handled these itself: who joined, and that
--                                 it carried the phone's offer to an operator
--                                 and that operator's answer back;
--   connected / ended             what one end reported, authenticated as that
--                                 end (an operator's session, the phone's
--                                 signature): that the call connected, and for
--                                 an operator how many video frames their
--                                 browser decoded;
--   approval_refused              an approval attempted with no such call on
--                                 record, and what was missing.

create table led.override_call (
  id              uuid        primary key default gen_random_uuid(),
  request_id      uuid        not null references led.seam_override_request(id),
  party           text        not null check (party in ('operator', 'field')),
  -- The operator this row is by, or the operator a field row is about.
  account_id      uuid        references ref.account(id),
  device_id       uuid        references ref.device(id),
  event           text        not null check (event in
                    ('joined', 'offered', 'answered', 'connected', 'ended', 'approval_refused')),
  detail          jsonb       not null default '{}'::jsonb,
  recorded_at     timestamptz not null default now(),
  check ((party = 'operator' and account_id is not null) or (party = 'field' and device_id is not null))
);

create index override_call_request_idx on led.override_call (request_id, recorded_at);

-- What the engine found about the call when each decision was made: every
-- check, and whether a call was required at that moment. Null on decisions
-- made before this migration.
alter table led.seam_override_decision add column call_evidence jsonb;

grant select, insert on led.override_call to mohar_app;
grant select on led.override_call to mohar_readonly;
