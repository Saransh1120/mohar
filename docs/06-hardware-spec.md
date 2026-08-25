# 06 - Hardware: ESP32 room monitor, and what we assume already exists

> **Revised for the software-only constraint.** No sealed appliances, no
> secure elements, no latches, no custom PCBs. One simple ESP32 device that we
> build, and otherwise only equipment the centre already owns.

## Part A - The throughput ceiling (a software concern)

Local printing is what collapses the exposure window, so its physical limits set
the boundary of digital mode. This lives in the software: the scheduler computes
it and **refuses to place a centre in digital mode that cannot physically finish**.

Assumptions, stated so they can be challenged: a mid-range office laser MFP rated
45-60 A4 sides/min sustains roughly **35 sides/min** once duplexing, collation
and paper reloads are counted. Print window is **45 minutes**.

| Scenario | Sides/copy | Candidates | Total sides | Printer-min | Printers needed | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| NEET-style, large centre | 48 | 480 | 23,040 | 658 | 15 | Infeasible |
| State PSC prelims | 16 | 300 | 4,800 | 137 | 4 | Marginal |
| Staff-selection objective | 12 | 240 | 2,880 | 82 | 2 | Feasible |
| University semester | 4 | 400 | 1,600 | 46 | 2 | Feasible |

**Design rule:** digital mode is viable when `candidates x sides <= ~5000` per
centre with three printers and an hour. Above that it collapses - which is why
the NTA does not locally print NEET, and why claiming digital delivery solves
NEET-scale pen-and-paper exams is not credible.

That refusal is a feature. Ship it in the MVP.

## Part B - The ESP32 room monitor (the only thing we build)

One device per strong room or control room. Target cost under Rs 1,200.

| Component | Part | Approx cost | Purpose |
| --- | --- | ---: | --- |
| MCU | ESP32-C3 or ESP32-WROOM-32 dev board | Rs 300 | Wi-Fi + BLE, plenty of GPIO |
| Door state | Reed switch + magnet | Rs 40 | Open/closed, the highest-value signal |
| Presence | HLK-LD2410C 24 GHz mmWave | Rs 300 | Detects a stationary person; no imaging, so no DPDP exposure |
| Footfall | 2x VL53L0X ToF, ~15 cm apart in the doorway | Rs 400 | Direction of travel gives in/out counting |
| Light | LDR + resistor | Rs 15 | Lights on in a sealed room at 02:40 is near-free intelligence |
| Time | DS3231 RTC | Rs 100 | Trustworthy timestamps when offline |
| Buffer | microSD module | Rs 100 | Local log survives power and network loss |

### How footfall counting actually works

Two ToF sensors in the doorway, fired alternately. The order in which the beams
break gives direction; the count of break-pairs gives people. Standard, cheap,
and no camera anywhere in the design.

**Accuracy caveat, stated up front:** two people walking abreast through a wide
door count as one. Real-world accuracy on a single-person doorway is good; on a
double door it is not. Report counts as *at least N*, never as exact, and treat
the door-open event as the reliable signal and the count as corroboration.

### Firmware rules

- **Heartbeat every 30 seconds.** The absence of a heartbeat is itself a ledger
  event. Unplugging the device is therefore not a way to go dark - it is a way to
  raise an alarm.
- **Write to SD before transmitting.** Pulling the power or jamming Wi-Fi must
  not erase the record.
- **RTC-stamped, monotonic sequence numbers,** so gaps in the record are visible
  rather than silent.
- **HMAC each record** with a per-device key provisioned at flash time.
- **BLE sync fallback:** where the school has no usable Wi-Fi, the device
  advertises over BLE and the field app drains its buffer on the next visit.

### Honest limits

ESP32 flash is readable. A determined attacker with physical access can extract
the HMAC key and forge records. This device is **tamper-evident, not
tamper-proof**, and its real value is the heartbeat gap and the anomaly log, not
cryptographic assurance. Do not oversell it.

And the point that matters most: at Hazaribagh the principal was *authorised* to
be in that room. Occupancy sensing is a detective control against unauthorised
entry and close to useless against authorised betrayal. Build it; do not let it
be the story.

## Part C - What the centre must already have

Nothing here is purchased by us or by them beyond consumables.

| Requirement | Why | Verified at |
| --- | --- | --- |
| A Windows 10/11 PC with TPM 2.0 | Device identity and WebAuthn platform authenticator, both free | Accreditation |
| N+1 working printers meeting the throughput check | A jam at 08:20 is exam-cancelling | Accreditation + mock drill |
| Generator or inverter | Laser fusers draw hard; outages are common | Load-tested at accreditation |
| Any internet connection, even intermittent | Only kilobytes of key material must arrive | Signal tested in the print room, not the corridor |
| Two smartphones with biometric unlock | Superintendent and observer WebAuthn credentials | Accreditation |
| Numbered one-time plastic seals | A few rupees each, no electronics | Supplied with each package |
| A sealed physical reserve set | The floor under every failure | Every digital-mode centre |
