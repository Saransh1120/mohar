# 14 · Seam seal — cryptographic binding and schema

**Session B** of the two-QR tamper-evident sealing design. Follows `docs/13`.
Grounded against branch `main` @ `3cee5ad` plus the uncommitted seam changes.

Every section is marked **implemented**, **designed** or **speculative**.

---

## 0 · A correction to the brief, and to docs/13

The brief lists a drand tlock round as one of three ways to defeat the clone
attack (F1). **It does not defeat cloning at all**, and it should not be offered
to a judge as if it did.

The clone attack does not need to know `s`. It needs a copy of the printed code.
If the label carries a tlock ciphertext of `s` instead of `s` itself, the courier
photographs the ciphertext, opens the package, and reprints the same ciphertext.
At the opening, after the round, that reprinted ciphertext decrypts to the right
`s` exactly as the original would have. Tlock stops someone *reading* the secret
early. It does nothing about someone *copying* it, and copying is the attack.

`docs/13 §10` carried tlock forward as an F1 candidate. That was wrong and is
corrected here; the ranking below drops it.

---

## 1 · The commitment — **implemented**

`packages/crypto-core/src/seam.ts`

| Item | Value |
| --- | --- |
| Token `s` | 32 bytes from `randomBytes` — `SEAM_TOKEN_BYTES` |
| Preimage | `s` (raw bytes) ‖ `packageId` (UTF-8) |
| Commitment | `sha256(preimage)`, lowercase hex, 64 characters |
| Comparison | constant-time over the hex digest — `seamTokenMatches` |
| Wire form of `s` | 64 lowercase hex characters, nothing else |

No length prefix is needed: `s` is fixed at 32 bytes and sits first, so the
boundary between token and id is never ambiguous.

**Why the package id is bound in.** A commitment over `s` alone is portable — a
token lifted from one package would satisfy the check on any other package whose
commitment happened to be built the same way. Binding the id makes each
commitment answerable by exactly one package's seal. It is the same reasoning
that makes the id associated data in `crypto-core/src/seal.ts`.

---

## 2 · Schema — **implemented**

| Change | File |
| --- | --- |
| `PackageSealedPayload.seamCommitment`, optional | `contracts/src/events.ts` |
| `AccessRequestedPayload.seamTokenRead`, optional, regex `^[0-9a-f]{64}$` | `contracts/src/events.ts` |
| `DenyReason`: `seam_token_absent`, `seam_token_mismatch` | `contracts/src/enums.ts` |
| `ref.package.seam_commitment char(64)`, hex check constraint | `infra/migrations/005_seam_seal.sql` |
| Check `seam_token`, unlock stage only | `ledger/src/domain/policy.ts` |
| Boundary validation of `seamTokenRead` | `ledger/src/http/access-routes.ts` |

**Both new fields are optional, and must stay optional.** Events already on the
chain were signed over canonical bytes that do not contain these fields. A
required field would make every old `PACKAGE_SEALED` fail validation. Optional
and omitted — never null — leaves their canonical bytes unchanged.

**No new event kind.** A seam read is carried inside the existing
`ACCESS_REQUESTED`, and the commitment inside the existing `PACKAGE_SEALED`,
which is already in `SERVICE_ONLY_KINDS` (`events.ts:65`). A field device
therefore cannot mint a commitment — invariant 3 holds without any new code.

**The migration grants nothing.** `005_seam_seal.sql` adds a nullable column and a
constraint, runs as `mohar_migrator`, and leaves `mohar_app` with `SELECT` and
`INSERT` only on the ledger. Invariant 2 holds.

**The check runs only at the unlock stage.** Every earlier checkpoint reads the
transit code, which carries the serial and authorises nothing. A first version
of this check ran at every stage and would have refused every handover the
moment a commitment existed; it was caught before any package carried one.

---

## 3 · Where `s` lives — **designed, not built**

`s` should exist in exactly two places: the printed label, and the process that
prints it, for as long as printing takes.

1. **Generated in `sealkeys`** at the moment a package is sealed.
2. **Committed first.** `sha256(s ‖ packageId)` goes into `PACKAGE_SEALED` before
   the label is rendered, so the chain holds the commitment before any copy of
   `s` leaves the generating process.
3. **Handed to `render`** to print the seam label, then discarded. `render` keeps
   nothing.
4. **Never written to the ledger.** Not at sealing, and — as implemented today —
   not at opening either: `recordAttempt` stores the seal serial that was read
   (`ledger/src/domain/keys.ts:268`) but not the seam token.

**Both services are empty.** `services/sealkeys` and `services/render` are a
`README.md` and `.gitkeep` files. Today nothing calls `generateSeamToken`, nothing
writes a commitment into `ref.package.seam_commitment`, and no label is printed.
The check exists; the path that would give it something to check does not. Every
package in the database reports `seam_token` as not evaluated, and will until
issuance is built.

---

## 4 · F5 — the print supply chain

Whoever renders the label sees `s`. That cannot be designed away: a printer has
to know what it is printing.

What can be done is to put the printing where the trust already is. The press
already handles the question paper in plaintext before encryption — it is the
most trusted point in the whole journey. Rendering the seam label there, in the
same session that seals the package, adds no new party to the set who could
leak it.

Residual risk: a compromised press defeats this, and it also defeats everything
else, because the press sees the paper. The seam seal does not claim to protect
a package from the people who printed its contents.

---

## 5 · F1 — the clone attack, ranked honestly

A courier photographs the seam code, opens the package, reprints the code on
fresh destructible stock, and reseals. The token reads, the commitment opens,
the check passes.

**None of the options below is complete.** They are ranked by how much of the
attack they actually remove.

| Rank | Option | What it removes | Residual | Status |
| --- | --- | --- | --- | --- |
| 1 | **Random fibre or speckle substrate**, enrolled at sealing and compared at opening | the reprint: a printer can copy the code but not the random fibre pattern in the stock | needs a perceptual matcher, a fibre-bearing substrate, and a threshold that will have false rejections | speculative |
| 2 | **Compare the seal photographs taken at each hop** | a reprinted label looks different under a camera from the one photographed at the previous handover | comparison is by a person, not a machine; a careful reprint may pass | partly implemented — every `HANDOFF` already carries `photoSha256` (`events.ts:96`) |
| 3 | **Bind `s` to the sealing photo's hash** | nothing on its own | two photographs of the same genuine seal hash differently, so an exact match rejects the genuine seal as readily as the clone — see F11 | not useful without rank 1 |
| — | ~~drand tlock gating~~ | **nothing** — see §0 | the attack copies ciphertext, not plaintext | removed |

The honest position for a judge: **the seam seal proves the flap was not torn
open. It does not prove the label on the flap is the one that was put there.**
Rank 1 is the only option that closes that gap, and it is not built.

---

## 6 · F10 — offline retry and the oracle question

**Duplicate submission.** Field devices queue events and retry; `led.event.id` is
the idempotency key, so a retried event is not written twice. An access request
is different — each call to `/access/request` is its own evaluation and writes
its own attempt. A station that retries the same unlock with the same token
produces two attempts with the same outcome. That is noise, not a flaw: both are
honest records of two requests. It should be deduplicated by `sessionId` in the
station, not in the ledger.

**Oracle.** The response distinguishes `seam_token_absent` from
`seam_token_mismatch`. That is an oracle in the narrow sense — it tells the
caller whether what they sent was well-formed and wrong. It is harmless here:
`s` is 256 bits, and learning that a guess was wrong narrows the space by one.
The distinction is kept because docs/13 §8 routing depends on it.

**Not an oracle for `s` itself.** The comparison is constant-time over the digest,
and the token is never echoed back or logged.

---

## 7 · F11 — what the photograph binds

`photoSha256` binds **which frame** was taken. It does not bind **that the seal in
the frame is genuine**. Two photographs of the same untouched seal, a second
apart, produce unrelated hashes.

So the chain can prove, later, that a given photograph is the one taken at a
given handover and has not been swapped since. It cannot say anything about
whether the seal changed between two handovers. That comparison is made by a
person looking at both photographs — which is rank 2 in §5, and exactly as
strong as the person doing it.

---

## 8 · F12 — what tlock does buy

The content key is already bound to a drand quicknet round
(`PackageSealedPayload.drandRound`, `crypto-core/src/drand.ts`). What that buys is
narrow and real: **nobody, including the board, can decrypt the paper before the
round is published.** A leak of every Shamir share a day early still yields
ciphertext.

What it does not buy:

- **Access control.** After the round, tlock is satisfied for everyone. Whether
  a given person may open a given package is the access engine's job.
- **Protection against cloning** — §0.
- **Protection of the paper after decryption.** Once opened, it is paper.

Early possession of ciphertext is expected and harmless. It is the design.

---

## 9 · Carried into Sessions C and D

- The station has no way to send `seamTokenRead` yet: no camera decode, no field
  in `lib/station.ts`. The engine is ready for input nothing can produce.
- `sealkeys` and `render` must exist before any package carries a commitment.
- Everywhere the project says **21 checks, 19 passed**, it now has **22 checks**.
  At the unlock stage today, with no commitments anywhere, a granted ceremony is
  **19 of 22**, with three not evaluated: occupancy, seal lock, and seam.
