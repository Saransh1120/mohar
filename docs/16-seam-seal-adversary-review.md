# 16 · Seam seal — adversary review and hard questions

**Session D** of the two-QR tamper-evident sealing design. Attacks the design in
`docs/13`–`15` as built on branch `main` @ `3cee5ad` plus the seam changes.

Where a mitigation does not close an attack, the residual risk says so. No row
has been closed by inventing a control.

---

## 1 · Attacks

| # | Attack | Mitigation | Residual risk |
| --- | --- | --- | --- |
| 1 | Photograph the seam code, open the flap, reprint, reseal | hop photographs compared by a person (`HANDOFF.photoSha256`) | **high** — a careful reprint passes the check; only a fibre substrate closes this, and it is not built |
| 2 | Peel the seam label off intact, open, re-stick | destructible vinyl fragments on removal | low, if the specified substrate is used; weaker on damp kraft |
| 3 | Tear through the data region only, so Reed–Solomon repairs it | tear line specified through two finder patterns, which carry no ECC | low against the specified label; a label printed without regard to the tear line loses this entirely |
| 4 | Open a side face, never touch the flap | none from this layer | **high** — the seam seal guards one opening, not the envelope |
| 5 | Read the contents without opening — backlight, lifted corner | none from any seal | **high** — no seal detects reading |
| 6 | Deliberately ruin the label to force a fallback, then exploit the looser fallback | fallback requires more witnesses, not fewer, and is service-decided | medium — depends on the fallback ceremony being run as designed; it is manual |
| 7 | Replace the whole package with a counterfeit carrying the real serial | device binding, roster, custody window, two-person ceremony | medium — this layer contributes nothing; the counterfeit simply has no commitment match |
| 8 | Send a hostile payload in the token field — injection, overlong, encoded | regex `^[0-9a-f]{64}$` at the HTTP boundary and in the contract | negligible |
| 9 | Guess the token | 256-bit random secret | negligible |
| 10 | Use the absent/mismatch distinction as an oracle | reveals only whether one guess was wrong | negligible against a 256-bit space |
| 11 | Time the comparison to learn the commitment | constant-time comparison over the digest | negligible |
| 12 | Lift a token from one package to satisfy another | package id bound into the commitment | negligible |
| 13 | Insider at the press copies `s` before the label is printed | commit before render; render at the press only | **high, and accepted** — the press sees the paper itself; the seal does not protect a package from the people who printed it |
| 14 | Mint a commitment from a field device | `PACKAGE_SEALED` is in `SERVICE_ONLY_KINDS` | negligible |
| 15 | Edit the stored commitment after sealing | `mohar_app` has no `UPDATE`; column change leaves a chain record that disagrees | low — a superuser can still edit `ref.package`; the chain record of `PACKAGE_SEALED` is the source of truth and would disagree |
| 16 | Steal the centre PC's signing key from `localStorage` and submit tokens as the centre | none in the browser today | **high** if the browser is the scanner — see `docs/15 §5` |

Four rows stay high: 1, 4, 5 and 13, plus 16 if the browser scans. They are the
honest shape of the design.

---

## 2 · F4 — one damaged label does not stop an exam

| Seam label state | Engine | What happens |
| --- | --- | --- |
| reads, matches | passes | ceremony proceeds normally |
| reads, does not match | refuses, `seam_token_mismatch` | package treated as compromised; photograph committed |
| will not read | refuses, `seam_token_absent` | operator invokes the witnessed fallback ceremony |
| package predates seam labels | not evaluated | ceremony proceeds on the other checks |

The key never depended on the seal. The content key is rebuilt from Shamir
shares (3 of 4) after a drand round, and neither of those reads a label. A
damaged seam changes *who must be present* and *what is recorded*. It does not
remove the ability to open the paper.

---

## 3 · Hard questions

**"Reed–Solomon means a torn QR still scans. Did you know that?"**
Yes. At ECC level L the symbol repairs 5 of its 44 codewords, so a tear through
the data region is recovered. That is why the tear line is specified through two
of the three finder patterns, which carry no error correction at all. Without
them a decoder cannot find the symbol. — `docs/13 §3`

**"What stops me photographing the QR and reprinting it?"**
Nothing in the seam seal. A copy of static data reads exactly like the original.
What catches it today is weaker: every handover already records a photograph of
the seal, and a reprint can be spotted by comparing them. The only real fix is a
label stock with random fibres a printer cannot reproduce, and we have not built
it. — `docs/14 §5`

**"Couldn't a timelock stop the copying?"**
No. The attacker copies the printed code, not the secret inside it. Timelock stops
someone reading the secret early; a reprint doesn't need to. — `docs/14 §0`

**"You said `sealkeys` generates the secret. `sealkeys` is an empty directory."**
Correct. It is a README. Today nothing generates a seam token and every package
reports the check as not evaluated. The check, the schema and the commitment
maths exist; the issuance path does not. — `docs/15 §1`

**"Your frontend holds a signing key in localStorage."**
Yes, and the file that does it says so. That is why the seam code should be read
by the ESP32 station, which signs with a key in its own flash. If the browser
scans, the record says it came from the centre PC and the weaker trust is shown.
— `apps/control-room/src/lib/witness.ts`, `docs/15 §5`

**"So scanning the code opens the packet?"**
No. A scan authorises nothing — the package page says exactly that. The seam
token is one of 22 checks, and the paper opens only when all of them pass and two
people are present. — `apps/control-room/src/pages/PackageDetail.tsx`

**"If rain ruins the label, is the exam cancelled?"**
No. An unreadable seam routes to a witnessed manual opening. The key comes from
Shamir shares and a drand round, neither of which reads the label. — §2 above

**"Why not put the whole thing on a blockchain?"**
There is one authority, the board. A blockchain buys consensus between parties
who don't trust each other; there are none here. Signatures and database
privileges give tamper evidence without a network. — `CLAUDE.md`, `docs/adr`

---

## 4 · Known gaps

- **Clone attack open** (row 1). Needs a fibre substrate and a matcher.
- **No issuance.** `sealkeys` and `render` are empty; no package has a commitment.
- **No reader.** Nothing decodes a QR from a camera; `station.ts` has no field for it.
- **Migration unapplied.** `005_seam_seal.sql` is written but not run.
- **Fallback is manual.** The witnessed ceremony after `seam_token_absent` is a
  procedure, not code.
- **Side-face and non-destructive reading** are outside what any flap seal can see.
- **The check count changed.** Materials that say "21 checks" or "19 of 21" are
  out of date; it is 22 checks, and a granted ceremony today is 19 of 22.
