begin;

-- -----------------------------------------------------------------------------
-- Who template slot 3 actually is
-- -----------------------------------------------------------------------------
--
-- The reader enrols and matches on its own flash and gives up two things: a slot
-- id and a score. The chain records "slot 3 matched, score 187" and nothing
-- more, which is what makes a breach of this database unable to leak a biometric
-- — there is no biometric in it to leak.
--
-- But a slot number is not an answer to "who opened the package". This table is
-- the missing half: a mapping from (station, slot) to a person on the roster. It
-- is reference data, exactly like ref.person, and it is deliberately NOT in the
-- ledger. The chain holds signed facts about what happened; who a template
-- belongs to is an administrative record that can be corrected, and correcting a
-- signed fact is precisely what the chain must never allow.
--
-- Note what is still absent: no image, no template, no minutiae. Only the fact
-- that a named person's finger was enrolled into a numbered slot on a named
-- device, and when.

create table ref.fingerprint_enrolment (
  id             uuid primary key default gen_random_uuid(),

  -- The station whose flash holds the template. Slots are per-device: slot 3 on
  -- one reader has nothing to do with slot 3 on another, so both halves are
  -- needed to identify an enrolment.
  device_id      uuid        not null references ref.device(id),
  template_slot  smallint    not null check (template_slot between 1 and 127),

  person_id      uuid        not null references ref.person(id),

  -- Recorded here as well as on ref.person because a person can be enrolled in
  -- one capacity at one centre and another elsewhere, and the ceremony cares
  -- about the capacity they were enrolled in.
  role           text        not null check (role in ('superintendent','observer')),

  -- Which finger, in the enroller's own words ("right index"). Free text because
  -- the value is for the person re-enrolling later, not for the engine.
  finger_label   text,

  enrolled_at    timestamptz not null default now(),
  enrolled_note  text,

  -- Enrolments are retired, not deleted. "This slot used to be someone else's"
  -- is a fact an investigator may need, and a deleted row cannot say it.
  revoked_at     timestamptz,
  revoked_reason text
);

-- One live enrolment per slot per device. A slot silently reassigned while the
-- old mapping still looked current would make every historical assertion for
-- that slot ambiguous.
create unique index fingerprint_enrolment_live
  on ref.fingerprint_enrolment (device_id, template_slot)
  where revoked_at is null;

create index on ref.fingerprint_enrolment (person_id);
create index on ref.fingerprint_enrolment (device_id, revoked_at);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
--
-- Reference data, so unlike the ledger the app may correct it: an enrolment
-- recorded against the wrong person has to be fixable. Deletion is still not
-- granted — retirement is an update to revoked_at, which leaves the history.

grant select, insert, update on ref.fingerprint_enrolment to mohar_app;
grant select on ref.fingerprint_enrolment to mohar_readonly;

commit;
