# 13 · Seam seal — feasibility and the physical layer

**Session A** of the two-QR tamper-evident sealing design.
Grounded against branch `main` @ `3cee5ad`.

Status of everything below: **designed, not built.** No QR encoder, decoder or
camera pipeline exists in this repo. This document specifies a label and states
what it can and cannot detect. It does not describe working code.

---

## 0 · Anchor corrections

Three claims in the design brief do not survive a read of the source. Two are
cosmetic; one changes what may be said out loud.

**`seal_serial` is at `001_init.sql:125`, not `:146.`** The column and its comment
read:

```sql
-- infra/migrations/001_init.sql:125
  seal_serial   text,                       -- numbered one-time plastic seal
```

**`DenyReason` begins at `enums.ts:63`, not `:832`.** The file is 88 lines long.
The member count of 19 is correct, and `seal_serial_mismatch` and
`seal_photo_missing` are both present, at lines 76 and 77.

**"The string `qr` appears in exactly one meaningful place" is wrong, and the
second place matters.** Besides the Zod enum in `contracts/src/events.ts:101`,
the control room already emits a scan event with `scanType: "qr"`:

```ts
// apps/control-room/src/lib/liveDemo.ts:483
payload: { scanType: "qr", rawIdentifier: identifier },
```

Nothing reads a camera — the identifier there is supplied by the demo, not
decoded from an image. But a judge who greps for "qr" will find this line, and
"there is no QR anywhere" is then a claim they have just falsified. The accurate
sentence is: **the event shape exists and the demo already produces one; no
encoder, decoder or camera pipeline exists.**

Everything else in the brief's anchor table verified as written, including
`SERVICE_ONLY_KINDS` (6 members, `events.ts:65`), the `SEAL_MISMATCH` partial
index (`001_init.sql:199`), and `shareCommitments` fixed at length 4
(`events.ts:82`).

---

## 1 · The secret against QR capacity

The seam QR carries a 32-byte secret `s` and nothing else. No prefix, no version
tag, no JSON. The context supplies the framing: a scanner at the opening ceremony
knows it is reading a seam QR because of where it is and what asked for it.

QR byte-mode capacity, low versions:

| Version | Modules | ECC L | ECC M | ECC Q | ECC H |
| --- | --- | --- | --- | --- | --- |
| 1 | 21 × 21 | 17 B | 14 B | 11 B | 7 B |
| **2** | **25 × 25** | **32 B** | 26 B | 20 B | 14 B |
| 3 | 29 × 29 | 53 B | 42 B | 32 B | 24 B |
| 4 | 33 × 33 | 78 B | 62 B | 46 B | 34 B |

**Version 2, ECC L, byte mode holds exactly 32 bytes.** Utilisation is 100% —
there is not one spare codeword, which is precisely what the design contract asks
for when it says the payload should sit near capacity.

The arithmetic, so it can be checked: version 2 has 44 total codewords. ECC L
assigns 10 to error correction and 34 to data. Thirty-four codewords is 272 bits;
subtract 4 bits of mode indicator and 8 bits of character count and 260 bits
remain, which is 32 bytes with 4 bits spare.

### Why not base64

Base64url of 32 bytes is 43 characters, which byte mode stores as 43 bytes and
which pushes the symbol to version 3. Base32 is 52 characters and does fit
alphanumeric mode, but also needs version 3 at ECC L. Raw binary at version 2 is
both smaller and, as section 3 shows, the fragility does not come from the
version anyway.

### A challenge to the design contract

The contract asks for "**low ECC (level L), high version**, payload packed near
capacity." Two of those three are right. **High version is wrong, and it works
against the goal.**

Fragility against tampering is governed by what proportion of codewords a tear
destroys relative to what the ECC can recover. That proportion is set by the ECC
level, not the version — level L recovers roughly 7% of codewords at every
version. Raising the version at a fixed physical label size only shrinks the
modules. Smaller modules do not make the symbol easier to tamper-detect; they
make it easier to break by accident, through abrasion, print defect, dust and
poor lighting. That is F3, the false-positive attack surface, made worse for no
detection gain.

**The recommendation is the lowest version that holds the payload: version 2.**

---

## 2 · What ECC level L actually costs

At version 2, ECC L, the symbol carries 10 error-correction codewords in a single
block, so the decoder can repair up to **5 corrupted codewords out of 44** — about
11% of the symbol's data region when the error positions are unknown.

This is the number that has to be said out loud, because the brief is right that
Reed–Solomon defeats the naive premise. **A small tear through the data region
still scans.** Removing four or five codewords' worth of modules from the data
area is fully recoverable. A fragile-looking QR is not a fragile QR.

The comparison that makes the point:

| ECC level | ECC codewords (V2) | Correctable | Recovery |
| --- | --- | --- | --- |
| L | 10 of 44 | 5 codewords | ~7% |
| M | 18 of 44 | 9 codewords | ~15% |
| Q | 24 of 44 | 12 codewords | ~25% |
| H | 30 of 44 | 15 codewords | ~30% |

Choosing L over H roughly halves the damage the symbol tolerates. That is worth
having, but on its own it is nowhere near enough to build a tamper claim on.

---

## 3 · The patterns that carry no error correction

This is where the fragility actually comes from, and it is a structural property
of the QR standard rather than a trick.

A QR symbol is not uniformly protected. Roughly 42% of a version 2 symbol is
**function patterns**, and the Reed–Solomon block covers none of them:

| Pattern | Size at V2 | Job | Protected? |
| --- | --- | --- | --- |
| Finder × 3 | 7 × 7 each | locate and orient the symbol | **no ECC** |
| Separators × 3 | L-shaped, 1 module | isolate the finders | **no ECC** |
| Timing, row and column 6 | 9 modules each | establish the module grid | **no ECC** |
| Alignment × 1 | 5 × 5 | correct perspective distortion | **no ECC** |
| Format information | 15 bits, ×2 copies | ECC level and mask | BCH, duplicated |
| Data + ECC | 44 codewords | the payload | RS, 5 correctable |

The format information is the exception — it is BCH-coded *and* written twice, so
losing one copy is survivable by design.

The finders are not. Commodity decoders — ZXing, ZBar, the scanners inside phone
camera apps — locate a symbol by searching the image for the finder pattern's
characteristic 1:1:3:1:1 dark-light ratio, and require three of them to establish
the symbol's corners and perspective. **Destroy one finder and the decode does
not degrade; it fails at localisation, before error correction is ever consulted.**

That is the hard failure the design needs, and it comes free with the standard.

### Where the tear line must fall

Through a finder pattern. Not near one — through it.

A tear does not have to bisect the 7 × 7 block. Clipping its outer rows is
sufficient, because it is the ratio scan that breaks, not the block's centre.
That tolerance is what makes the placement manufacturable.

The best available geometry places the tear **3 to 5 modules below the symbol's
top edge**, running horizontally so it crosses **both** the top-left and top-right
finder patterns, and with them the format-information strip that runs beside each.
Two finders and one format copy gone in a single straight tear.

A vertical tear through the left-hand column would take the top-left and
bottom-left finders equally well; the choice between them is set by which way the
package flap actually opens, not by the symbol.

What should **not** be specified is a tear through the middle of the symbol. That
crosses the data region and the alignment pattern, and lands squarely in the
territory where Reed–Solomon does its job.

---

## 4 · Substrate

The symbol only has to survive as long as the label does. If the label peels off
intact, the tear never happens and the geometry above is irrelevant.

| Substrate | Behaviour on removal | Weakness |
| --- | --- | --- |
| **Destructible vinyl (egg-shell)** | fragments into pieces; cannot be lifted whole | adhesion falls off on rough kraft; degrades in humidity and heat |
| VOID polyester | leaves a VOID pattern on label and surface | detects peeling, not tearing; the QR itself survives |
| Frangible paper | tears very easily | also tears by accident; poor in damp |
| Standard PP with laminate | survives everything | survives peeling too — useless here |

**Seam QR: destructible vinyl.** It is the only one of these that defeats
peel-and-reapply, which is the attack that would otherwise walk straight past a
tear-line design.

**Transit QR: laminated polypropylene.** This one is supposed to survive.

The honest weakness: egg-shell vinyl's adhesion to unlaminated kraft paper is the
soft joint in the whole assembly, and it gets softer in monsoon humidity. A label
that falls off on its own produces exactly the false positive that section 6
has to route around.

---

## 5 · Module size and print resolution

| | Seam QR | Transit QR |
| --- | --- | --- |
| Version | 2 (25 × 25) | 1 (21 × 21) |
| ECC | **L** | **H** |
| Payload | 32 raw bytes | seal serial, ≤ 10 chars alphanumeric |
| Module | 0.90 mm | 1.20 mm |
| Symbol | 22.5 × 22.5 mm | 25.2 × 25.2 mm |
| Quiet zone | 4 modules (3.6 mm) | 4 modules (4.8 mm) |
| Print | 300 dpi thermal transfer | 203 dpi acceptable |

`S-82914` is 7 characters and every one of them is in the alphanumeric charset,
so the transit QR fits version 1 at ECC H with three characters to spare.

On resolution: at 300 dpi a dot is 0.085 mm, so a 0.90 mm module is about 10.6
dots and its edges are clean. At 203 dpi the same module is 7.2 dots, which is
inside tolerance but leaves ragged edges — and at ECC L there is very little
margin to absorb ragged edges. **Specify 300 dpi for the seam label.** The transit
label at ECC H has margin to spare and can be printed on whatever is available.

A 0.90 mm module is comfortable for a phone camera at 100–150 mm; the practical
floor is nearer 0.4 mm.

---

## 6 · The label specification

**Seam label — across the opening flap**

```
55 mm wide × 32 mm tall, destructible vinyl, 300 dpi thermal transfer

  ┌───────────────────────────────────────────┐  ─┐
  │                                           │   │ 5.0 mm  on the flap
  │   ┌───────────────────────────────┐       │   │
  │   │ ███████   ·  ·  ·   ███████   │       │   │
- - - -│- ██   ██- - - - - - ██   ██ -│- - - - │- -┼─  tear line, 8.15 mm
  │   │  ██   ██          ██   ██     │       │   │   from label top
  │   │  ███████    ·      ███████    │       │   │   = 3.15 mm into the
  │   │                               │       │   │     symbol
  │   │   ·   ·  · data region ·   ·  │       │   │
  │   │  ███████                      │       │   │
  │   │  ██   ██         ▓▓▓▓▓        │       │   │
  │   │  ███████         ▓▓▓▓▓        │       │   │
  │   └───────────────────────────────┘       │   │
  │        version 2 · ECC L · 22.5 mm        │   │
  └───────────────────────────────────────────┘  ─┘
```

The tear line crosses both top finder patterns at 3.5 modules below the symbol's
top edge, taking the adjacent format-information copy with them. Above the tear,
8.15 mm of label sits on the flap; below it, 23.85 mm on the body.

**Transit label — top face**

Version 1, ECC H, 25.2 mm square, laminated polypropylene, positioned on a flat
face away from any seam or edge. It encodes the seal serial and nothing else, and
losing it is a logistics problem, never a security one.

---

## 7 · F2 resolved — Reed–Solomon does not defeat this design

It defeats the naive version of it, and the naive version must not be claimed.

There is no QR standard that fails on minimal damage. Every level of ECC exists
specifically to survive damage, and level L still repairs 5 of 44 codewords.

The fragility in this specification comes from three stacked measures, none of
which is sufficient alone:

1. **The tear crosses two finder patterns.** Finders carry no error correction and
   commodity decoders need all three to localise the symbol at all. This is the
   measure that does the actual work — the failure is at detection, not decoding.
2. **ECC level L with the payload at 100% capacity.** Halves the tolerated damage
   compared to level H and leaves no spare codewords.
3. **Destructible vinyl.** Removes peel-and-reapply as a way to avoid the tear
   entirely.

Stated the other way round: if a judge asks whether a torn QR still scans, the
answer is **yes, if the tear is only through the data region — which is why the
tear line is specified through the finder patterns instead.**

---

## 8 · F3 resolved — a torn seal must not cancel an exam

Fragility is an attack surface. A design that refuses on damage hands anybody
with rain, a forklift or a fingernail the power to stop an examination.

The routing, which is the part that matters:

| What the station finds | What is recorded | What happens next |
| --- | --- | --- |
| Seam QR reads, digest matches | normal `ACCESS_REQUESTED` path | ceremony proceeds |
| Seam QR reads, digest wrong | `SEAL_MISMATCH` | refuse, photograph, escalate |
| Seam QR will not read at all | `SEAL_MISMATCH` | **witnessed manual ceremony**, not refusal |
| Label absent entirely | `SEAL_MISMATCH` | same, with the absence recorded |

An unreadable seam and a wrong seam are not the same event and must not collapse
into the same outcome. The first is ambiguous and needs more witnesses; the second
is evidence.

Two constraints from the existing system shape this:

**No severity labels.** This repo's rule is that alerts state what happened and
what is known, and do not rank themselves as critical or high or medium
(`CLAUDE.md`). So the brief's instruction to "grade severity" is implemented as
**different routing**, not as a severity field. A torn seam is distinguished from
a mismatched seam by the path it takes and the record it leaves, never by a label
attached to it.

**The station cannot declare its own fallback.** `FALLBACK_INVOKED` is in
`SERVICE_ONLY_KINDS` (`events.ts:65`), so a field device may not emit it. The
station reports what it read — or that it read nothing — and the service decides.
This is the correct shape and it falls out of the existing design without change.

---

## 9 · What this catches, and what it does not

The brief asks for the percentage of tampering caught versus missed. **That number
cannot be produced honestly and should not be quoted.** A percentage requires a
known distribution of attacks by frequency, and no such distribution exists for
exam paper interference in India — the only public data is on leaks that were
detected, which is the wrong denominator. Any figure would be invented, and a
judge who asks where it came from would be owed an answer that does not exist.

What can be stated is categorical, and it is enough:

**Caught**

| Attack | Why it fails |
| --- | --- |
| Tear the flap open, take papers, reseal with tape | seam QR destroyed at the finder; no `s` to present |
| Peel the seam label, open, re-apply the same label | destructible vinyl fragments; cannot be re-applied |
| Open carefully, avoiding the seam | there is no careful way past the flap; the label spans it |
| Swap in a different seal serial | `seal_serial_mismatch` — an existing check, unchanged |

**Missed — stated plainly**

| Attack | Why this layer does not see it |
| --- | --- |
| **Photograph the seam QR, open, reprint on fresh destructible stock, reseal** | `s` is static data. Copying static data is free. **This is the design-killer and the physical layer cannot answer it** — it is deferred to Session B, which must bind `s` to something unclonable or gate it behind a drand round. |
| Slit a side face and extract papers without touching the flap | the seam label guards one opening, not the envelope's integrity |
| Read the contents without opening — backlighting, a corner lifted and photographed | no seal detects reading |
| A wholly counterfeit package with a matching serial | guarded, if at all, by device binding and roster checks, not by this label |
| Memorisation by someone authorised to be in the room | outside the reach of any custody system |

The honest summary is that this layer detects **the flap having been opened**, and
detects it well. It does not establish that the contents are untouched, and it
does not survive an adversary with a printer. Both of those are real, both are
disclosed, and one of them is Session B's entire job.

---

## 10 · Carried into Session B

- **F1**, unresolved and load-bearing. Ranked options: bind `s` to the existing
  `photoSha256` of the seal surface; bind to a randomised fibre or speckle pattern;
  gate `s` behind a drand quicknet tlock round so it is worthless before the
  scheduled opening. None is complete.
- The byte layout of `s` and of the commitment preimage, and why `packageId` is
  bound in — the same reasoning that makes it AAD in `crypto-core/src/seal.ts`.
- Where `s` lives between sealing and opening, given that `sealkeys` and `render`
  are `README.md` plus `.gitkeep` files and nothing else.
- New `DenyReason` members. `seam_token_absent` and `seam_token_mismatch` are the
  candidates, and they must be distinguishable for section 8's routing to work.
- Migration `005_seam_seal.sql`, written to leave `mohar_app` without `UPDATE` or
  `DELETE`.
