# 03 - Cryptographic design

> **Constraint:** software only, no paid services, no custom hardware. Every
> primitive below is free and uses capability already present in hardware the
> centre owns. See `adr/0004-no-paid-dependencies.md`.

## The one property we claim

> No single party - including the platform operator - can produce the plaintext
> of an exam paper before the exam start instant.

It is binary, provable from the architecture, and costs nothing to build.

## Why "encrypt with a daily-rotated key" does not work

1. **Rotation is the wrong dial.** It defends against a key quietly stolen and
   reused over time. Our threat is a *valid* key used correctly, once, by an
   authorised person, a few hours early. A daily key is fully valid for the whole
   exam day - and the Hazaribagh compromise happened on the morning of the exam.

2. **A key that can be delivered can be delivered early.** `if (now >= startAt)`
   is a policy check in application code, bypassable by whoever runs the server,
   the DBA who can update the row, or anyone who can move a clock. It relocates
   trust from the school principal to us. That is a bigger target, not a fix.

3. **The key exists too early.** Material generated at encryption time sits
   somewhere for days, and every day is an exfiltration opportunity.

## The four locks, rebuilt for zero cost

Content key `K` encrypts the bundle with XChaCha20-Poly1305 (libsodium, free).
`K` is split by Shamir into 4 shares, threshold 3.

| Share | Held by | Protected under | Cost |
| --- | --- | --- | --- |
| S1 | Exam authority | Passphrase-wrapped (Argon2id), stored on our server | Free |
| S2 | *Nobody, yet* | `tlock` to the public drand beacon round at `startAt` | Free |
| S3 | Centre superintendent | WebAuthn platform authenticator (Windows Hello / Android biometric) | Free |
| S4 | Independent observer | WebAuthn platform authenticator on their own phone | Free |

Any 3 of 4 reconstruct `K`. S2 is unobtainable by anyone until the beacon
publishes, so opening early needs **all three** remaining holders to collude -
across three organisations, leaving a trail in three places.

### What we lose without an HSM, stated plainly

With a FIPS 140-2 Level 3 HSM, S1 could never be extracted even by a full server
compromise. Without one, S1 is a passphrase-wrapped blob on our infrastructure.
An attacker who fully owns our servers **and** obtains one more share can open a
package early.

The threshold split still means we are not a single point of failure, which was
the whole point. But do not claim HSM-grade custody. If a customer requires it
later, S1 moves to their HSM with no change to the rest of the design.

## Lock B - the part that is free and genuinely strong

`tlock` (Gailly, Melissaris, Romailler - IACR ePrint 2023/189) over drand's
threshold BLS beacon. The decryption key for a future round does not exist
anywhere in the world until drand's distributed operators publish it. Not a
policy check - an unforgeable fact about the state of the world.

`drand` runs a free public API (`api.drand.sh`), `tlock-js` is open source, and
there is no account, quota, or billing anywhere in the path.

```ts
const round = roundAt(chainInfo, startAt);   // genesis + period * n
const ct    = await tlock.encrypt(shareS2, chainInfo, round);
// Always verify chainInfo against the pinned DRAND_CHAIN_HASH before use.
```

Pin the chain hash, cache `chainInfo`, and treat a beacon that disagrees with the
pinned hash as a hostile network rather than a transient error.

## Lock C - TPM you already own

Every Windows 11 machine has TPM 2.0, and Windows 10 machines from ~2016 mostly
do. Every modern Android phone has a hardware-backed Keystore. We use what is
already in the box:

- The centre client binds its device identity to a TPM-resident keypair and
  proves possession on every request. Free.
- The WebAuthn platform authenticators behind S3 and S4 ride on that same TPM or
  Android Keystore - so "two-person co-presence" costs zero rupees in tokens.

### What we lose without a sealed appliance, stated plainly

On an ordinary PC the decrypted PDF exists in RAM during the print window. A
determined operator with admin rights and a memory dump can extract it. We
mitigate, we do not eliminate:

- The plaintext is never written to disk - render straight to the spooler.
- The print window is minutes, not hours.
- Every extracted copy is still watermarked, so extraction remains **attributable**.

This is exactly why `render` and `trace` carry more of the product's real value
than this document does.

## The offline fallback - deliberately painful, and free

Beacons need network. Many centres have neither reliable connectivity nor power.

Fallback: two control-room operators each authenticate with their own platform
authenticator and release a replacement for S2. Delivery is by whatever channel
exists - and because paid SMS gateways are out, the default is an operator
**reading a short alphanumeric code over a phone call**, which the centre types
in. Crude, free, and auditable because the call is logged as a ledger event.

Every one of these conditions is required:

- Two distinct control-room operators authorise.
- Exam authority and independent observer are alerted synchronously.
- Rate-limited per exam; exceeding it escalates to a named human decision.
- `FALLBACK_INVOKED` is written to the ledger **before** the share is released.
- Every invocation is reviewed post-exam and the aggregate count published.

**This is the weakest link in the system.** It re-introduces the central-operator
risk that Lock A exists to remove. Measure it, publish it. "Fallback used at 3 of
4,750 centres" is credible; hiding the path is not.

## Key lifecycle at the centre

1. Ciphertext bundle pre-staged days ahead. Only key material arrives on the day,
   and it is a few kilobytes.
2. At `startAt` the beacon publishes; the client recovers S2.
3. Superintendent and observer each complete a WebAuthn assertion - two-person rule.
4. Shares combine in memory; `K` is zeroised immediately after the print job.
5. Print controller meters exactly N copies, watermarking each.
6. `KEY_DESTROYED` is signed and queued.

## Where cryptography stops

At the printer tray. Past that point it is paper, a room, and people with phones.
Everything after is physical control and attribution.
