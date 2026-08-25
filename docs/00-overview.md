# 00 — Overview and scope

## The problem we are solving

Between 2015 and 2026, roughly 148 exam-fraud incidents were documented across 21
Indian states, producing **one** conviction. Paper leaks are ~70% of those cases.
The failure is therefore not primarily detection — leaks are usually discovered
within days — but **evidence and attribution**: chain of custody cannot be proved
to a court's standard, and no one can say which centre a leaked image came from.

## Build constraints

Software-first. The only hardware we build is a simple ESP32 room monitor (door
state, footfall, presence, light) costing under Rs 1,200. No paid or premium
dependency anywhere in the stack. `adr/0004-no-paid-dependencies.md` records
every substitution and what each costs us in assurance.

## What we build

A platform with two operating modes, sharing one custody ledger, one identity
layer, and one control room.

**Digital mode** — the paper is delivered as sealed ciphertext, decryptable only
at the centre, only at exam time, and printed locally. Exposure window drops to
under an hour. Viable only where `candidates x sides <= ~5000` per centre
(see `06-hardware-spec.md` for the throughput ceiling).

**Escorted mode** — for high-volume pen-and-paper exams above that ceiling,
physical logistics remain, but every package carries an electronic seal, every
handoff is signed into the ledger, and every printed copy is fingerprinted.

Fingerprinting and the ledger work identically in both modes. That is deliberate:
it means one product, and it means the attribution capability does not depend on
a customer adopting digital delivery first.

## Target customers (MVP)

Not the NTA — between 2024 and 2026 they built much of the physical stack
already. Target: state public service commissions, state police and
staff-selection boards, universities running semester examinations, school
boards, PSU and bank recruitment, professional certification bodies.

## Commercial hook

The Public Examinations (Prevention of Unfair Means) Act 2024, as amended in
2026, exposes service providers to fines up to Rs 1 crore, eight-year debarment,
and personal criminal liability for directors — plus a statutory **duty to
report** incidents. Our ledger is both the mechanism that discharges that duty
and the due-diligence defence. We sell compliance infrastructure, not "security".

## Explicit non-goals

- Eliminating leaks entirely. Not achievable; claiming it destroys credibility.
- Item authoring / question banking (integrate, do not build).
- AI behavioural proctoring — legally fraught under DPDP for under-18 candidates.
- Blockchain. We need admissibility and third-party notarisation, not consensus.
- Any hardware beyond the ESP32 room monitor: no latches, secure elements or PCBs.
- Any dependency needing a paid tier: no cloud HSM, MDM, SMS gateway or Maps API.
