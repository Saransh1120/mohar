# ADR 0003 - Device identity via Android Keystore attestation, not MDM

**Status:** accepted (supersedes the earlier MDM-enrolled-devices decision)

## Context

The design called for binding a custody scan to the phone's SIM identity. On
Android 10+, IMEI, IMSI and SIM serial require `READ_PRIVILEGED_PHONE_STATE`,
which Play Store apps cannot declare - it is limited to platform-signed apps,
privileged system apps, and device/profile owners.

An earlier ADR resolved this by issuing MDM-enrolled devices. That is now out of
scope: commercial MDM is a paid product, and issuing hardware conflicts with the
software-first constraint.

## Decision

Generate a keypair in the **Android Keystore** with `setAttestationChallenge`,
and verify the resulting hardware attestation certificate chain server-side.

## Rationale

- The OS attests that the private key lives in secure hardware and cannot be
  exported. That binds a custody record to one specific physical phone.
- Free, works on ordinary consumer phones, needs no privileged permission and no
  MDM vendor.
- For our purpose - proving *which device* produced a record - this is stronger
  than a SIM serial, which is transferable between handsets in seconds.

## Consequences

- We lose remote wipe and app allowlisting. Acceptable: the app holds no
  plaintext paper, only signed custody records.
- A rooted or unlocked-bootloader device will fail attestation. That is correct
  behaviour; such devices are refused enrolment.
- Device identity remains **one input among several**, never the decision.
