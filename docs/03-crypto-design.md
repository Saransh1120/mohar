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

## The opening key, in four parts

The opening key `K` encrypts the bundle with XChaCha20-Poly1305 (free). It is
split so that the control room's part is always needed and two officials from
two institutions are needed with it:

```
K          =  controlPart  XOR  fieldKey
fieldKey   ->  Shamir 2-of-3  ->  superintendent · board observer · police escort
```

| Part | Held by | Protected under | Cost |
| --- | --- | --- | --- |
| Control room part | *Nobody, until the scheduled minute* | `tlock` to the drand round fifteen minutes before `startAt` | Free |
| Official 1 | Centre superintendent | Wrapped to the role at sealing, to the named officer's device a day ahead | Free |
| Official 2 | Board observer | The same | Free |
| Official 3 | Police escort | The same | Free |

The XOR is what makes the control room's part mandatory rather than likely:
all three officials together reconstruct `fieldKey`, and `fieldKey` alone opens
nothing. That part does not exist in readable form before the beacon publishes,
so opening early is not a matter of who colludes. And the two officials must
answer to two different institutions: `combineOpeningKey` refuses a pair from
one, because a 2-of-3 across three people who report to the same office is one
signature.

This replaced an earlier Shamir split of four shares with a threshold of three,
in which the authority was one holder among four and could be outvoted.
`shamir.ts` keeps that scheme for packages already sealed under it.

**What is built.** The split and its refusals (`opening-key.ts`) and the time
lock (`timelock.ts`), both in `packages/crypto-core`, both tested. The Live Demo
page splits a key this way and opens with it. **What is not:** no service issues
the envelope, wraps the officials' parts to a duty roster, or runs the opening
ceremony. Until `sealkeys` and `unlock` exist, no packet in the field is
actually opened with this key.

### What we lose without an HSM, stated plainly

Between sealing and the moment the control room's part is time-locked, that
part exists in the clear inside whatever process generated it. With a FIPS
140-2 Level 3 HSM it could be generated and wrapped without ever being
readable. Without one, an attacker who fully owns that process during that
interval, **and** obtains two officials' parts, can open a package early.
Time-locking at sealing rather than a day ahead shrinks the interval to
nothing; that is a design choice still open.

Do not claim HSM-grade custody.

## Lock B - the part that is free and genuinely strong

`tlock` (Gailly, Melissaris, Romailler - IACR ePrint 2023/189) over drand's
threshold BLS beacon. The decryption key for a future round does not exist
anywhere in the world until drand's distributed operators publish it. Not a
policy check - an unforgeable fact about the state of the world.

`drand` runs a free public API (`api.drand.sh`), `tlock-js` is open source, and
there is no account, quota, or billing anywhere in the path.

```ts
// round = roundAtOrAfter(scheduledOpenTime), against the pinned quicknet chain
const envelope = await wrapControlPart(controlPart, scheduledOpenTime, policy);
// later, offline, once that round's beacon value is in hand:
const controlPart = await unwrapControlPart(envelope, beacon);
```

`timelock.ts` does not fetch. It takes the beacon value as an argument, because
the station's copy runs in a room with no route to the internet.

Pin the chain hash, cache `chainInfo`, and treat a beacon that disagrees with the
pinned hash as a hostile network rather than a transient error.

## Lock C - TPM you already own

Every Windows 11 machine has TPM 2.0, and Windows 10 machines from ~2016 mostly
do. Every modern Android phone has a hardware-backed Keystore. We use what is
already in the box:

- The centre client binds its device identity to a TPM-resident keypair and
  proves possession on every request. Free.
- The credentials the officials' parts are wrapped to ride on that same TPM or
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

The first answer is that the opening does not need the network at the moment
it happens. The time-locked envelope and the wrapped officials' parts are cached
on the station a day ahead; at the scheduled minute the station needs only that
round's beacon value, 48 bytes, from any public relay, a LAN cache or an
officer's phone.

Where even that fails, the fallback: two control-room operators each
authenticate with their own platform authenticator and release a replacement
for the control room's part. Delivery is by whatever channel
exists - and because paid SMS gateways are out, the default is an operator
**reading a short alphanumeric code over a phone call**, which the centre types
in. Crude, free, and auditable because the call is logged as a ledger event.
An opening outside its window needs the control room's part, **all three**
officials and control-room approval. None of this fallback is built.

Every one of these conditions is required:

- Two distinct control-room operators authorise.
- Exam authority and independent observer are alerted synchronously.
- Rate-limited per exam; exceeding it escalates to a named human decision.
- `FALLBACK_INVOKED` is written to the ledger **before** the share is released.
- Every invocation is reviewed post-exam and the aggregate count published.

**This is the weakest link in the system.** It re-introduces the central-operator
risk that the time lock exists to remove. Measure it, publish it. "Fallback used
at three centres out of 4,750" is credible; hiding the path is not.

## Key lifecycle at the centre

1. Ciphertext bundle pre-staged days ahead. Only key material arrives on the day,
   and it is a few kilobytes.
2. Fifteen minutes before `startAt` the beacon publishes; the station recovers
   the control room's part.
3. Two officials from different institutions each verify - the two-person rule -
   and their parts unwrap.
4. The parts combine in memory; `K` is zeroised immediately after the print job.
5. Print controller meters exactly N copies, watermarking each.
6. `KEY_DESTROYED` is signed and queued.

## Where cryptography stops

At the printer tray. Past that point it is paper, a room, and people with phones.
Everything after is physical control and attribution.
