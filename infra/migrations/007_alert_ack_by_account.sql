-- 007 · an alert can be acknowledged by the operator account that saw it
--
-- 006 required every acknowledgement to name a ref.person. The people who
-- acknowledge alerts are control room operators, and they sign in with a
-- ref.account, which may or may not be linked to a person on the roster yet.
-- Refusing the acknowledgement until someone links the two would lose exactly
-- the fact this table exists for: who knew, and when.
--
-- So an acknowledgement names the account that made it, and the person too
-- when the account is linked to one. It must name at least one of them.
--
-- Run as mohar_migrator.

alter table led.alert_ack
  alter column person_id drop not null;

alter table led.alert_ack
  add column account_id uuid references ref.account(id);

alter table led.alert_ack
  add constraint alert_ack_names_someone check (person_id is not null or account_id is not null);

create index alert_ack_account_idx on led.alert_ack (account_id, acked_at desc);
