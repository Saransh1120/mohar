# 07 - Field operations runbook

The UX budget here is larger than the crypto budget. The person driving the
centre client is a school computer teacher doing this once or twice a year under
intense pressure, not an IT professional.

## Accreditation (T minus 30 days)

- Verify printer count, model, and rated speed against `ref.centre.printers`.
- Verify generator or inverter presence and run a 10-minute load test.
- Verify internet reachability inside the actual print room, not the corridor.
- Compute the throughput check; refuse digital mode if it fails.
- Enrol devices by attestation; register rostered personnel and their platform
  authenticators (Windows Hello on the centre PC, biometrics on their phones).

## Mock drill (T minus 7 days)

Unannounced where possible. Dummy paper, real hardware, real people, full
protocol. Score on: time to first page, time to last page, custody completeness,
exception count. Centres that fail the drill drop to escorted mode. This is the
only way to know the system works before the day it must.

## Exam day

| Time | Action |
| --- | --- |
| T-180m | Centre PC powered, self-test, ciphertext integrity check |
| T-120m | Package arrives; handoff scanned; two signatures captured |
| T-90m | Superintendent and observer complete a dry-run WebAuthn check (no unlock) |
| T-60m | Beacon round approaches; centre client polls, caches `chainInfo` |
| T-45m | Unlock: beacon share + two platform-authenticator shares; print window opens |
| T-40m..T-5m | Metered printing, per-copy watermarking |
| T-5m | Print complete, key zeroised, `KEY_DESTROYED` signed |
| T | Exam starts |
| T+15m | Trace monitoring active on public channels |

## Failure playbook

| Failure | Response |
| --- | --- |
| No network at T-60m | Control room dual-authorises out-of-band S2. Log first, release second. |
| Printer jam, under 10 min lost | N+1 spare takes the remaining queue automatically |
| Printer jam, over 10 min lost | Escalate; sealed physical reserve set is the floor |
| Power loss | Genset or inverter must carry both the PC and the printers |
| Credential holder absent | Named alternate on roster, or control-room dual-auth. Never a shared credential. |
| Seal serial mismatch, or room monitor logged an off-window entry | **Stop.** Do not print. Escalate to authority and police. Paper is presumed compromised. |
| Leak detected mid-exam | Trace to centre, freeze that centre's scripts, notify authority within 15 min |

## The rule that overrides all of the above

A sealed physical reserve set exists at every digital-mode centre. If everything
fails, the exam still runs. No security control is permitted to become the reason
23 lakh candidates lose a year.
