-- WebAuthn challenges are short-lived, one-use reference data. They are not
-- custody events; transfer rulings remain append-only in led.transfer_attempt.
create table ref.webauthn_challenge (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('register', 'transfer')),
  person_id uuid not null references ref.person(id),
  device_id uuid references ref.device(id),
  leg_id uuid references ref.route_leg(id),
  step text check (step in ('dispatch', 'receive', 'confirm')),
  challenge text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check ((purpose = 'register' and device_id is null and leg_id is null and step is null)
      or (purpose = 'transfer' and device_id is not null and leg_id is not null and step is not null))
);
create index on ref.webauthn_challenge (person_id, issued_at desc);
grant select, insert, update on ref.webauthn_challenge to mohar_app;
