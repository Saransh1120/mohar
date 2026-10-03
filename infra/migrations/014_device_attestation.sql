-- Run as mohar_migrator.

-- ── what was ruled about a device's key when it was enrolled ────────────────
--
-- One row per enrolment attempt, written in the same transaction as the device
-- row, or instead of it when the attestation was refused. ref.device.attestation
-- keeps the bytes that were presented; this keeps what the ledger made of them:
-- every check, passed, failed or not evaluated, and why.
--
-- `absent` is an outcome, not a gap: a device enrolled with nothing presented
-- is on record as exactly that, so nobody later reads the lack of a refusal as
-- a verification.

create table led.device_attestation (
  id                  uuid        primary key default gen_random_uuid(),
  -- Null when the enrolment was refused and no device was made.
  device_id           uuid        references ref.device(id),
  pubkey              bytea       not null check (octet_length(pubkey) = 32),
  device_kind         text        not null,
  outcome             text        not null check (outcome in ('verified', 'refused', 'absent')),
  enrolled            boolean     not null,
  checks              jsonb       not null,
  -- What the chain said about the key: security level, boot state, the leaf's
  -- serial. No key material.
  facts               jsonb       not null,
  attestation_sha256  char(64)    check (attestation_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at         timestamptz not null default now(),
  -- A refusal makes no device; anything else does.
  check (enrolled = (device_id is not null))
);

create index device_attestation_device_idx on led.device_attestation (device_id, recorded_at desc);
create index device_attestation_pubkey_idx on led.device_attestation (pubkey, recorded_at desc);

grant select, insert on led.device_attestation to mohar_app;
grant select on led.device_attestation to mohar_readonly;
