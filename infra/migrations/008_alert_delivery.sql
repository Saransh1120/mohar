-- 008 · who was told about an alert, by which channel, and whether it got there
--
-- An alert on a page reaches only someone looking at the page. The notifier
-- sends each alert out by Telegram and email, and every attempt to do so is a
-- row here: the channel, whether the far end accepted it, and what it said if
-- it did not.
--
-- This is the notifier's memory as well as its record. "Has this alert been
-- sent on this channel" is answered by reading this table, so a ledger that
-- restarts does not send everything again, and a channel that was down is
-- retried without a status column to update. led.* takes no UPDATE: a failed
-- attempt and the later successful one are two rows, and the gap between them
-- is how long the control room went without being told.
--
-- Run as mohar_migrator.

create table led.alert_delivery (
  id            uuid        primary key default gen_random_uuid(),
  alert_id      uuid        not null references led.alert(id),
  channel       text        not null,
  outcome       text        not null check (outcome in ('sent', 'failed')),
  -- What the far end answered when it refused, or the error reaching it.
  detail        text,
  attempted_at  timestamptz not null default now()
);

create index alert_delivery_alert_idx on led.alert_delivery (alert_id, channel, attempted_at desc);

grant select, insert on led.alert_delivery to mohar_app;
grant select on led.alert_delivery to mohar_readonly;
