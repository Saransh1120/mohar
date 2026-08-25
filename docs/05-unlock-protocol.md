# 05 - Package access protocol

> **Revised for the software-only constraint.** The earlier draft used an
> electronic latch. That is custom hardware and is out of scope. This version
> achieves the same *investigative* outcome with software plus a five-rupee
> non-electronic seal.

## The honest statement of what software can and cannot do

**Software cannot lock a physical box.** Anyone holding a trunk and a cutting
tool opens it. What software can do is make every opening either **authorised and
recorded**, or **unauthorised and unmistakably evident**. That is the whole
design goal, and it is enough - because the Hazaribagh failure was not a locking
failure. The trunk was opened by people who had the keys.

## Two modes, two very different answers

### Digital mode - there is no box

The paper is ciphertext on the centre's PC. There is nothing physical to unlock.
Access control is entirely cryptographic (`03-crypto-design.md`), which is exactly
why digital mode is the strong mode: no latch, no seal, no hardware, and the
guarantee is mathematical rather than mechanical.

The QR/custody flow below applies only to the physical items that still exist in
digital mode: OMR sheets, the sealed reserve set, and used scripts.

### Escorted mode - a box with a cheap seal

Physical trunks are sealed with **numbered one-time plastic security seals** -
the kind used on cash bags and utility meters, a few rupees each, no electronics.
Each seal serial is registered against the package at sealing time.

## Why the QR is not the key

A QR code is data printed on a surface. Anyone who photographs it holds a perfect
copy. It is an **identifier**, never a secret. Scanning it opens an authorisation
session; the decision is made server-side against evidence the scanner cannot
forge.

## What *is* the key: a stage-scoped, six-hour credential

Identity alone was never sufficient. Knowing *which attested phone* and *which
rostered human* opened a session says nothing about whether that person was
supposed to be at that stage of custody at that hour. So each of the eight
custody stages carries its own key, valid for one six-hour epoch:

```
seal → dispatch → transit → custodian → centre → unlock → print → destroy
```

Four properties, each chosen against a specific failure:

| Property | Against |
| --- | --- |
| Scoped to one stage of one package | A courier's key opening a package; a superintendent's re-routing one in transit |
| Valid for one six-hour epoch | A key photographed once being valid for the rest of the exam cycle |
| Expiry derived from the clock, never scheduled | An expiry job that silently stops running, leaving keys live forever |
| Stored only as SHA-256 | A database dump yielding working credentials |

The key format is Crockford base32 with the ambiguous characters removed —
`MHR-UNLOCK-9F2K-4TQX-…` — because it has to be read aloud over a bad phone line
at 04:00 without anyone confusing `0` for `O` or `1` for `l`. A ±30 minute grace
either side of the boundary means a handoff in progress when the epoch rolls over
is not stranded.

**A key is displayed exactly once, at issue.** It cannot be recovered afterwards;
losing it means rotating to the next epoch. That is the intended cost of a
credential that cannot be extracted from a database.

See `adr/0005-custody-keys-expire-by-arithmetic.md`.

## Why SIM binding does not work

On Android 10+, IMEI, IMSI and SIM serial require `READ_PRIVILEGED_PHONE_STATE`,
which Play Store apps cannot declare - it is limited to platform-signed apps,
privileged system apps, and device/profile owners. Commercial MDM is a paid
product and therefore out of scope too.

**What we use instead, free and stronger for our purpose:** an Android Keystore
keypair with **hardware-backed key attestation**. The OS attests that the private
key lives in secure hardware and cannot be exported. That binds the record to a
specific physical phone without buying anything, without MDM, and without needing
privileged permissions. See `adr/0003-device-identity-without-mdm.md`.

## Protocol

```
field-app                         access svc
    |                                  |
 1. scan QR/NFC -> package_id          |
 2. biometric unlock; custodian        |
    asserted via WebAuthn              |
 3. app REQUIRES a photo of the        |
    seal before it will proceed        |
    |                                  |
 4. POST /access/request ------------->|
    { package_id, stage,               |
      presented_key,                   |
      device_id, person_id, gps,       |
      accuracy, ts, seal_serial_read,  |
      session_id }                     |
    |                                  |
    |                          5. evaluate policy
    |                             (deny by default,
    |                              every check, always)
    |                                  |
    |                          5a. record the attempt
    |                              BEFORE replying
    |                                  |
 6. <---- ACCESS_GRANTED / DENIED -----|
    signed decision receipt            |
    |                                  |
 7. app displays result; on DENIED it  |
    shows a full-screen refusal the    |
    custodian must photograph to       |
    override, and that override is     |
    itself a ledger event              |
```

## Policy checks in step 5

Deny by default. Fifteen checks, and **every one is evaluated on every request**.

| Check | Denies |
| --- | --- |
| A custody key was presented at all | Session opened with identity alone |
| Key hash matches one we issued for this package | A key from elsewhere, or a guess |
| Key is inside its epoch window | A credential kept past its shift |
| Key authorises the stage being requested | A transit key used to unlock |
| Keystore attestation valid, device not revoked | Cloned or emulated app |
| Device not bound to a different centre | A centre PC authorising another centre's package |
| Person on `ref.roster` for this centre and exam, now | Wrong human |
| Person's role matches the stage's expected role | A courier acting as superintendent |
| GPS inside `centre.geofence_m` | Package moved off-site |
| Fix accuracy sufficient to place the device in the fence | A fix too vague to mean anything |
| `now` inside the authorised custody window | The 02:40 scan |
| Device clock within tolerance | A clock rolled forward to fake a window |
| Seal serial read matches the registered serial | Seal cut and replaced |
| Package state permits this act | Out-of-order handling, already opened, compromised |
| Exam not suspended by control room | Kill switch |

### Why every check runs, even after the first failure

Short-circuiting would be cheaper and is the usual instinct. We do not, because an
attempt that trips four checks is a materially different event from one that trips
a clock skew, and **there is no second chance to observe an attempt that already
happened.** The record has to be complete the first time.

### Why the attempt is recorded before the caller is told

`led.access_attempt` is written inside the same transaction, before the response
is returned. There is no ordering in which a client learns the outcome without the
attempt being on record — a client that crashes on receiving a denial has still
left evidence behind.

That table has no `UPDATE` or `DELETE` grant, for the same reason `led.event` has
none. A refused attempt is the highest-value row the system produces.

### Evidence, not verdicts

The attempt record stores `412` metres, not `outside_geofence`. It stores the epoch
presented alongside the epoch current, not `expired`. A verdict without its inputs
cannot be re-examined, and this record has to stand up as an FIR annexure years
later, when the roster and the geofence may both have changed.

## The override, and why it exists

Because software cannot physically stop anyone, a custodian *can* proceed after a
DENIED decision. The app does not pretend otherwise. It makes proceeding
expensive: a full-screen refusal, a mandatory photograph, a typed reason, and an
`OVERRIDE_USED` event that pages the control room in real time.

An override is not a failure of the system. It is the system working - converting
an invisible act into a timestamped, geolocated, photographed, personally
attributed record.

## Offline behaviour

The field app is offline-first. With no network it evaluates the cached policy
locally, records the decision, and queues everything signed at creation time.
Cached policy is more permissive than server policy by necessity, so every
offline grant is flagged for reconciliation on sync.

## What this gives an investigation

For every package, whether or not anything went wrong: which attested physical
device scanned it, which rostered human authenticated, where, when, with what GPS
accuracy, what the camera saw of the seal at that instant, whether the request
was granted or denied and why, and whether anyone overrode a denial.

For a state-wide sweep, this is one query. See `10-feature-catalogue.md` I1-I3.

## Honest limits

- A custodian can authenticate correctly and then hand the open package to
  someone else. This protocol cannot see that. Fingerprinting can.
- A seal photo can be faked with a previously photographed seal. Mitigate by
  requiring the photo to include the package QR and seal in one frame, and by
  spot-checking serials at the next handoff.
- Nothing here stops a determined thief. It guarantees that theft leaves a
  record, which is the difference between 148 cases and 1 conviction.
