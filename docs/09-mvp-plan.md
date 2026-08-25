# 09 - MVP plan

Twelve weeks, small team. One pilot: a single state-level or university
examination, under the throughput ceiling, one district, 20-50 centres.

| Weeks | Build | Proves |
| --- | --- | --- |
| 1-3 | `ledger`: hash-chained signed event store, device enrolment, package and seal registry, RFC 3161 anchoring, `verify-portal` | The audit trail is tamper-evident and independently checkable |
| 3-6 | `field-app`: offline-first NFC/QR handoff scanning, dual-signature capture, geotag, local queue and sync | The chain records cleanly with zero connectivity |
| 5-8 | `sealkeys`: Shamir 3-of-4, tlock to the public drand beacon, WebAuthn share custody, dual-authorised fallback | No single party - including us - can open a package early |
| 6-9 | `access` policy engine + `firmware/room-monitor`: deny-by-default decisions, seal-photo capture, ESP32 door/footfall/heartbeat telemetry | Every access attempt and every room entry is recorded, granted or not |
| 7-10 | `render` + `centre-client`: metered N-copy printing, per-centre permutation, copy serial and watermark, key destruction | The exposure-window collapse, end to end |
| 9-11 | `trace`: upload a photo of a printed paper, recover centre and copy | Attribution in under a minute - the demo that wins the room |
| 11-12 | `control-room`: custody-gap alarms, incident timeline, signed evidence-pack export | Operational readiness and the compliance story |

## Explicitly out of MVP scope

Item banking and paper authoring (integrate, do not build). AI proctoring.
Facial recognition. Any custom hardware beyond the ESP32 room monitor - the centre
client runs on the school PC and its existing TPM. OMR scanning. Any HSM - see
ADR 0004 for the free substitutions and what each one costs us in assurance.


The room monitor gets a **three-centre pilot** only: door contact, ToF footfall
and mmWave presence, to validate alerting before building units at scale.

## Build order rationale

`ledger` first because everything else emits into it and it is the component that
carries the compliance value on its own - it is sellable before any of the
cryptography exists. `trace` late but not last, because it is the demo that
converts sceptics, and it needs `render` to exist first.

## Success criteria for the pilot

| Metric | Target |
| --- | --- |
| Exposure window | Under 1 hour (from ~240 h) |
| Attribution latency | Under 10 minutes |
| Custody completeness | Over 99.5% of expected handoffs recorded |
| Fallback invocation rate | Under 0.5% of centres |
| Print completion before start bell | 100% of centres |
| Parties who can unilaterally produce plaintext before T | **0** |

That last row is the one to lead with. Binary, provable from the architecture,
and not currently claimable by any incumbent.
