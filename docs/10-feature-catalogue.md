# 10 - Feature catalogue

Ordered by security value per unit of effort, not by how impressive they sound.
`M` = in the 12-week MVP. `V1` = first production release. `V2+` = later.

## Core custody

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| C1 | Hash-chained append-only custody ledger | M | Role-enforced immutability |
| C2 | Nightly Merkle root + RFC 3161 notarisation | M | Third-party timestamp, not consensus |
| C3 | Public verification portal | M | Anyone can verify a record existed unaltered |
| C4 | Offline-first field scanning with dual signatures | M | Must work with no signal on a cheap phone |
| C5 | Device enrolment via Android Keystore / TPM attestation | M | No MDM, no purchased hardware |
| C6 | Signed evidence-pack export | M | FIR annexure format |
| C7 | Personnel rotation engine | V1 | No repeated route/centre/pairing across cycles |
| C8 | Returnable-asset tracking for room monitors and seal stock | V1 | Same ledger, different object class |

## Sealed delivery

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| S1 | Shamir 3-of-4 content-key split | M | Removes the operator as a single point |
| S2 | tlock encryption to a drand round | M | Early release stops being a human decision |
| S3 | Two-person co-presence via WebAuthn platform authenticators | M | Windows Hello / Android biometrics; nothing purchased |
| S4 | Dual-authorised out-of-band fallback | M | The weakest link; measured and published |
| S5 | Metered N-copy printing with key zeroisation | M | Plaintext never leaves the secure element |
| S6 | Throughput pre-check that refuses impossible centres | M | Refusal is the feature |
| S7 | Pre-staged ciphertext on physical media | V1 | Only key material travels on the day |

## Package integrity

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| P1 | Deny-by-default access decisions with signed receipts | M | QR is an identifier, never a key |
| P2 | Numbered plastic seal + mandatory seal photo in frame with the QR | M | Five rupees, no electronics |
| P3 | Deny-by-default policy engine with reason codes | M | Denied scans are the highest-value signal |
| P6 | Stage-scoped custody keys on a six-hour rotation | M | Expiry by arithmetic, not a cron job — failure closes. ADR 0005 |
| P7 | Immutable access-attempt record with full evidence | M | Every presentation kept, including keys we never issued |
| P4 | Override capture: full-screen refusal, photo, typed reason, live page | M | Software cannot stop the act; it makes it expensive and attributable |
| P5 | ESP32 room monitor: door, ToF footfall, mmWave presence, light, heartbeat | V1 | Under Rs 1,200. Detective only; useless against authorised betrayal |

## Attribution - the highest-leverage cluster

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| A1 | Per-centre block-constrained permutation | M | Robust channel; survives a cropped blurry photo |
| A2 | Typographic watermark encoding a copy serial | M | Medium robustness; dies under heavy compression |
| A3 | Overt margin serial + QR | M | Brittle but free; leakers are often not careful |
| A4 | Leak-response console: image in, centre out | M | Under a minute. The demo that wins the room |
| A5 | Per-seat permutation with per-copy answer keys | V1 | Needs a hardened scoring reconciliation layer |
| A6 | Canary papers seeded into specific custody paths | V1 | A canary surfacing identifies the path with certainty |
| A7 | Per-setter fingerprinted item drafts | V2 | Reaches upstream of the logistics chain |

## Intelligence and investigation

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| I1 | Custody-gap scoring per package and route | V1 | Unexplained gaps, route deviation, off-window handling |
| I2 | State-wide anomaly sweep | V1 | All suspicious events in one state on exam day, as one query |
| I3 | Result-anomaly correlation | V1 | Score clusters cross-referenced against custody irregularities |
| I4 | Public-channel leak monitoring (free Telegram Bot API) | V1 | Twenty minutes early is one centre cancelled, not a national exam |
| I5 | Repeat-personnel graph analysis | V2 | Documented leaks involved the same contractor staff repeatedly |

## Trust and transparency

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| T1 | Candidate-facing custody timeline for their own packet | V1 | Turns lakhs of anxious people into auditors |
| T2 | Published fallback-invocation counts | V1 | Credibility comes from disclosing the weak path |
| T3 | Chaos drills with centre accreditation scoring | V1 | Unannounced, real hardware, scored |
| T4 | Published permutation-equivalence statistics | V1 | Pre-empts the fairness writ petition |

## Strategic

| # | Feature | Phase | Notes |
| --- | --- | --- | --- |
| X1 | Late randomised centre allocation | V2 | Attacks the leak market business model, not the mechanism |
| X2 | Large calibrated item bank with late assembly | V2 | Strongest structural fix; a content-ops investment |
| X3 | Sequestered composition environment | V2 | Non-networked machines, no removable media |
| X4 | Path to computer-based testing | V2+ | Removes paper entirely; ledger and identity layers carry over |

## The fairness risk attached to A5

Candidates will argue a different question order made their paper harder, and in
India that argument reaches the courts. Mitigate by permuting only within
difficulty-matched blocks from item-bank calibration data, publishing the
methodology in advance, and being able to demonstrate statistical equivalence
across variants after the fact. Have this defence ready before the first live
deployment, not after the first writ petition.
