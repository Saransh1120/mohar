# ADR 0002 - The QR code is an identifier, not a key

**Status:** accepted (amended for the software-only constraint)

## Context

An early design had the package unlocked by scanning a QR code, with the scan
capturing device and SIM identity for attribution. A first revision replaced this
with an electronic latch. That latch is custom hardware and is now out of scope.

## Decision

The QR/NFC tag carries only a package identifier. Scanning opens a server-side
authorisation session evaluated deny-by-default. The physical closure is a
**numbered one-time plastic seal**, and the app requires a photograph of that
seal before it will proceed.

## Rationale

A QR code is data printed on a surface; anyone who photographs it holds a perfect
copy, so it can never be the secret. That reasoning is unchanged.

What changed is the enforcement. Software cannot lock a box. It can require that
every opening is either authorised and recorded, or unauthorised and evident.
Given that the Hazaribagh compromise was carried out by people who legitimately
held the keys, a latch would not have prevented it either - so the loss from
dropping it is smaller than it first appears.

## Consequences

- No hardware cost beyond a few rupees of seal per package.
- A custodian can proceed after a denial. The app cannot stop them, so it makes
  the act expensive instead: full-screen refusal, mandatory photo, typed reason,
  and an `OVERRIDE_USED` event that pages the control room in real time.
- Seal-serial verification depends on a photograph, which can be faked with a
  previously captured image. Mitigated by requiring seal and package QR in one
  frame, and by spot-checking serials at the next handoff.
