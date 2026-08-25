# ADR 0004 - No paid or premium dependencies

**Status:** accepted

## Context

The project must be buildable and runnable without purchasing a premium tier of
any service, and without custom hardware beyond simple ESP32 devices.

## Decision

Every component in the stack uses a free, open, or already-owned capability.
Where the free option is weaker than the paid one, we say so in the doc that
depends on it rather than quietly assuming the paid service.

## Substitutions made

| Originally | Cost | Replaced with | Cost |
| --- | --- | --- | --- |
| AWS CloudHSM / KMS for share S1 | Paid | Argon2id passphrase-wrapped share on our server | Free |
| FIDO2 hardware security keys | ~Rs 2,000 each | WebAuthn platform authenticators (Windows Hello, Android biometrics) | Free |
| Sealed mini-PC appliance with secure element | Purchase | The centre's existing Windows PC and its TPM 2.0 | Free |
| Electronic latch with solenoid and tamper loop | Custom hardware | Numbered one-time plastic seal + mandatory seal photo | ~Rs 5 |
| Commercial MDM (Hexnode, SOTI) | Paid | Android Keystore hardware-backed key attestation | Free |
| Paid SMS gateway for fallback share delivery | Paid | Control-room operator reads a short code over a phone call | Free |
| Google Maps in the control room | Billing required | Leaflet + OpenStreetMap tiles | Free |
| Commercial timestamp authority | Paid | A free RFC 3161 TSA endpoint | Free |
| Managed Postgres | Paid | Self-hosted Postgres in Docker | Free |
| drand / tlock | - | Already free and public, no account | Free |

## What this costs us

Three real reductions in assurance, each documented where it applies:

1. **No HSM.** Share S1 is extractable by an attacker who fully owns our servers.
   The threshold split means that alone is still not enough, so we are not a
   single point of failure - but this is not HSM-grade custody.
   (`03-crypto-design.md`)
2. **No sealed appliance.** The decrypted PDF exists in RAM on an ordinary PC
   during the print window and can be extracted by an operator with admin rights.
   Mitigated by a short window, never touching disk, and watermarking - so
   extraction stays attributable. (`03-crypto-design.md`)
3. **No electronic latch.** Software cannot physically stop a box being opened.
   It converts opening into an attributable, photographed, timestamped record.
   (`05-unlock-protocol.md`)

None of these touch Lock B, the timelock beacon, which is the strongest control
in the system and costs nothing.

## Upgrade path

Each substitution is isolated behind an interface. A customer who wants HSM
custody moves S1 into their HSM with no other change. One who wants sealed
appliances swaps the centre client's key-handling module. Nothing else moves.
