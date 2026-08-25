# ADR 0003 - Scanning devices are MDM-enrolled, not BYOD

**Status:** accepted

## Context

The design called for binding a scan to the scanning phone's SIM identity. On
Android 10+, IMEI, IMSI and SIM serial require `READ_PRIVILEGED_PHONE_STATE`,
which Play Store apps cannot declare. It is available only to platform-signed
apps, privileged system apps, or apps that are the device/profile owner.

## Decision

Issue MDM-enrolled devices where our app is the device owner.

## Rationale

- The only path to hardware identity without shipping a platform-signed ROM.
- Brings remote wipe, app allowlisting and enrolment revocation, all of which we
  need anyway.
- Standard practice in cash logistics and banking field operations, so it is not
  a novel ask in procurement.

## Consequences

Hardware procurement and device lifecycle become our problem. Devices become
returnable ledger assets alongside appliances and seals. Hardware identity
remains one input among several, never the decision.
