# 08 - Legal and compliance

## The statute is the business case

**Public Examinations (Prevention of Unfair Means) Act, 2024** covers exams by
the UPSC, SSC, Railway Recruitment Boards, IBPS, NTA and other notified
authorities. Under the 2024 Act:

- Service-provider offences: fine up to **Rs 1 crore**, recovery of the
  proportionate cost of the examination, and debarment.
- Director / senior management liability where the offence involved their consent
  or connivance: imprisonment 3-10 years and a fine of Rs 1 crore.
- An affirmative **duty to report** unfair means to police and the examination
  authority. Failure to report is itself deemed an offence.

An **Amendment Bill, 2026** passed both Houses in late July 2026: individual
imprisonment raised to 5-10 years, maximum individual fine from Rs 10 lakh to
Rs 50 lakh, service-provider debarment from 4 years to 8, plus fast-track
investigation and Special Fast Track Courts with Special Public Prosecutors.

> **Verification caveat.** Passage and headline figures are confirmed from
> parliamentary press releases and legislative trackers. The enacted gazette text
> was not retrievable at the time of writing. Confirm against the gazette before
> putting these numbers in a customer-facing deck.

**How this sells:** every examination service provider in India now carries Rs 1
crore exposure, eight-year debarment risk, personal criminal liability for its
directors, and a statutory reporting duty. Our ledger is simultaneously the
mechanism that discharges the duty and the contemporaneous, signed,
third-party-timestamped record that constitutes a due-diligence defence. That is
a board-level risk line item with a number attached, not a security nice-to-have.

## Privacy - DPDP Act, 2023

Section 9 requires verifiable parental consent before processing personal data of
anyone under 18, and prohibits **tracking or behavioural monitoring of children**.
A large share of NEET and board-exam candidates are 17.

The draft DPDP Rules, 2025 provide exemptions for specified classes of data
fiduciary, with educational institutions among the classes named in the Fourth
Schedule, subject to conditions - but exemptions are bounded to the specific
purpose granted.

### Product consequences

| Decision | Rationale |
| --- | --- |
| No AI behavioural proctoring | Gaze tracking, anomaly scoring and emotion inference on minors is legally fraught. Out of scope. Get counsel before revisiting. |
| Biometric verification at entry only | A bounded purpose is defensible; continuous monitoring is not. Keep it bounded. |
| mmWave occupancy, not cameras, in strong rooms | Counting people without imaging them keeps us outside the hardest part of the regime while giving the same signal. |
| Split retention policies | Custody-ledger events are operational records with a long justifiable life. Candidate biometric templates are not. Never store them together. |
| Hash government IDs | `ref.person.govt_id_hash`, never the raw number. |

## Evidence handling

Attribution reports are intended to be annexed to an FIR. That means:

- The signing key for reports is generated offline and kept separate from every
  operational service key. With no HSM in scope it lives passphrase-wrapped on a
  machine that does not run the application, and is never loaded by a service.
- Reports embed the ledger anchor (day, Merkle root, TSA token) that covers the
  events they cite, so a third party can verify the record existed unaltered at
  that time.
- Confidence is always reported numerically and never rounded to "match".
  An attribution that cannot be defended under cross-examination is worse than
  no attribution.
