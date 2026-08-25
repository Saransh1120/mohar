# 01 — Threat model

## Design constraint

**Every control in the NEET-UG 2024 failure was defeated legitimately.** The
trunks reached the correct building. The people who opened them were the people
authorised to be in that room. The seal was defeated without visible breakage.

An insider with legitimate access defeats every perimeter control by definition.
The system must therefore assume that *any single participant is potentially
hostile*, including the platform operator.

## Adversaries

| # | Adversary | Capability | Primary control |
| --- | --- | --- | --- |
| A1 | Item setter / moderator | Sees content weeks ahead, off-premises | Large item bank + late assembly; per-setter fingerprinted drafts |
| A2 | Translator / DTP operator | Full plaintext, least vetted in chain | Sequestered composition, non-networked machines |
| A3 | Press floor worker | Physical access to printed sheets | Digital mode removes the press entirely |
| A4 | Transport contractor staff | Custody for days, familiar routes | Numbered seal + photo, ledger gaps, personnel rotation |
| A5 | Custodian bank / treasury staff | Multi-day storage access | Seal serial checks + ESP32 room monitor + time-lock |
| A6 | Centre superintendent | **Authorised** access at the critical moment | Two-person rule, threshold key, fingerprinting |
| A7 | Platform operator (us) | Could hold keys, could alter logs | Shamir split, timelock beacon, hash-chained + TSA-notarised ledger. Without an HSM, S1 falls to a full server compromise; the split still stops us acting alone |
| A8 | Candidate | Photographs paper in hall | Per-seat fingerprinting; out of logistics scope |
| A9 | External attacker | Network compromise of our services | Standard appsec; note that A7 controls also blunt A9 |

## What each lock actually defeats

- **Threshold split (Shamir 3-of-4)** — defeats A7 and any single institution.
- **Timelock (drand/tlock)** — defeats early release as a *human decision*. The
  key does not exist before the beacon round, so no one can be bribed for it.
- **TPM-bound device identity** — raises the cost of copying the decrypted PDF but
  does not prevent it on an ordinary PC. Extraction stays *attributable*.
- **Two-person co-presence** via WebAuthn platform authenticators (Windows Hello,
  Android biometrics — nothing purchased) — defeats a lone actor at the centre (A6).
- **Fingerprinting** — defeats nothing preventively; converts A6/A8 leaks from
  unattributable to prosecutable, which is the actual deterrent.

## Known weakest link

The **offline fallback** (see `03-crypto-design.md`). A centre with no network
cannot reach the beacon, so a control room must issue a replacement share
out-of-band. This re-introduces A7. It is mitigated by dual authorisation, hard
rate limits, immutable logging, mandatory post-exam review, and publishing the
invocation count as a headline metric — not by pretending it is secure.

## Out of scope

Coercion of a custodian's family. Nation-state hardware implants. Physical
assault on transport. These are real but are police problems, not software ones.
