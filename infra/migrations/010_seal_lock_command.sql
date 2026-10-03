begin;

-- A granted access attempt may authorise at most one physical command. The
-- record is append-only and counters are per packet. An expired, undelivered
-- command consumes a counter; the board accepts a later, higher one.
create table led.seal_lock_command (
  attempt_id       uuid primary key references led.access_attempt(id),
  package_id       uuid not null references ref.package(id),
  command_counter  bigint not null check (command_counter between 1 and 4294967295),
  expires_at       timestamptz not null,
  issued_at        timestamptz not null default now(),
  unique (package_id, command_counter)
);

grant select, insert on led.seal_lock_command to mohar_app;
grant select on led.seal_lock_command to mohar_readonly;

commit;
