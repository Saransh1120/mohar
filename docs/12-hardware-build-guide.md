# 12 - Hardware build guide: room monitor and witness station

> Companion to `docs/06-hardware-spec.md` (what the hardware is) and Parts F-H of
> `docs/learn/Mohar-Roadmap-and-Flows.pdf` (why it is scoped the way it is).
> This document is how you actually build and integrate it.

---

## Part A - What you are building, and what changed on the way

Three devices are described in the roadmap. Two are built here.

| Device | MCU | Status in this repo |
| --- | --- | --- |
| Room monitor | ESP32-WROOM-32 or ESP32-C3 | **Built.** `firmware/room-monitor` |
| Witness station | ESP32-S3-WROOM-1, 8 MB PSRAM | **Built.** `firmware/witness-station` |
| Seal lock | ESP32-C6 | Not built. See Part G. |

### One correction to the spec, made deliberately

`docs/06-hardware-spec.md` says "**HMAC** each record with a per-device key
provisioned at flash time". Nothing in the software has ever accepted an HMAC.
The only entrance to the chain is `POST /events`, which verifies an **Ed25519
signature over the RFC 8785 canonical form of the body** against the public key
in `ref.device` (`services/ledger/src/append.ts`).

So the firmware signs with Ed25519. This is not a downgrade of the spec, it is
the spec catching up with the system: an HMAC ingest would have needed a second,
monitor-shaped entrance to the ledger with its own verification path, and a
second entrance to an append-only chain is exactly the thing you do not want.
Signing with Ed25519 means an ESP32 is authenticated by the identical code that
authenticates a field phone, with no special case anywhere.

Everything else about the firmware rules in the spec is implemented literally:
30-second heartbeat, write-to-SD-before-transmit, RTC-stamped monotonic
sequence numbers, per-device key at flash time.

---

## Part B - Bench setup

### What you need beyond the components

- A 5 V supply rated **2 A or better**. The ESP32-S3 driving the camera and the
  Wi-Fi radio is the top-ranked integration risk in the roadmap, and it presents
  as an apparently random reboot at the exact moment of capture. A 500 mA USB
  port is the usual cause.
- A microSD card, 4-32 GB, formatted **FAT32**. exFAT will not mount.
- A soldering iron for the reed switch and LDR. Everything else is jumper wires.
- PlatformIO. Either the VS Code extension or the CLI:

```bash
pip install -U platformio
```

### A note on 3.3 V

Every sensor here runs at 3.3 V logic. Two traps:

- **The fingerprint module.** A true **R307 wants 4.2-6.0 V** and will not
  enumerate reliably on 3.3 V. Its close cousins on the same AS608 chipset -
  ZFM-20, FPM10A, and most modules sold as "AS608" - are **3.3 V** parts.
  The two look nearly identical and are often sold under each other's names, so
  identify yours before wiring; Part D.3 is the procedure.

  If it is a 5 V part, power it from 5 V and put a divider on its **TX** line
  (1 kΩ in series, 2 kΩ to ground) before it reaches the ESP32. ESP32-S3 GPIOs
  are not 5 V tolerant and 5 V straight into one will damage it. The other
  direction needs nothing: 3.3 V from the ESP32 clears the module's logic-high
  threshold.
- **The HLK-LD2410C.** Powers from 5 V, but its UART is 3.3 V logic. Wire it
  directly; do not level-shift.

---

## Part C - The room monitor

One per strong room or control room. Emits `MONITOR_HEARTBEAT` and `ROOM_ENTRY`,
both of which already exist in `packages/contracts` — this device integrates with
the ledger as it stands, with **no server change at all**.

### C.1 Wiring — ESP32-WROOM-32 devkit

| Component | Its pin | ESP32 pin | Note |
| --- | --- | --- | --- |
| DS3231 RTC | VCC / GND | 3V3 / GND | Fit the coin cell |
| | SDA / SCL | **GPIO21** / **GPIO22** | Shared I2C bus |
| VL53L0X (outer, corridor side) | VIN / GND | 3V3 / GND | |
| | SDA / SCL | GPIO21 / GPIO22 | |
| | XSHUT | **GPIO25** | Address assignment at boot |
| VL53L0X (inner, room side) | VIN / GND | 3V3 / GND | ~15 cm from the outer one |
| | SDA / SCL | GPIO21 / GPIO22 | |
| | XSHUT | **GPIO26** | |
| HLK-LD2410C | VCC / GND | **5V** / GND | 3.3 V UART, 5 V supply |
| | TX | **GPIO16** | module TX → ESP32 RX |
| | RX | **GPIO17** | module RX ← ESP32 TX |
| Reed switch | leg 1 / leg 2 | **GPIO27** / GND | Magnet on the door leaf |
| LDR divider | LDR top | 3V3 | |
| | LDR bottom + 10 kΩ | **GPIO34** | ADC1 — see below |
| | 10 kΩ other leg | GND | |
| microSD (SPI) | VCC / GND | 5V / GND | Most breakouts regulate to 3.3 V |
| | CS / SCK / MOSI / MISO | **GPIO5 / 18 / 23 / 19** | |
| Status LED | — | GPIO2 | Onboard on most devkits |

**GPIO34 is not arbitrary.** It is on ADC1. ADC2 is unusable the moment Wi-Fi is
running, and an LDR wired to an ADC2 pin reads plausible garbage on the bench and
returns zero in the field.

**Both VL53L0X sensors ship on the same I2C address (0x29).** That is what the
XSHUT pins are for: the firmware holds both in reset, releases the outer one and
moves it to 0x30, then releases the inner one on the factory address. If you skip
the XSHUT wiring, neither sensor will be addressable.

### C.2 Mounting

- The reed switch goes on the **frame**, the magnet on the **door leaf**, with
  under 10 mm between them when shut.
- The two ToF sensors face **across** the doorway at roughly waist height, about
  15 cm apart along the direction of travel. Which one is "outer" is a wiring
  decision, and getting it backwards silently inverts every entry into an exit —
  walk through once and check the serial output before you screw anything down.
- The LD2410C wants a clear view into the room. It sees through thin plasterboard,
  which is a feature for concealment and a nuisance for false positives from the
  corridor. Aim it away from the door.

### C.3 Accuracy, stated before anyone asks

Two people walking abreast through a wide door count as **one**. This is not a
tuning problem, it is what a two-beam counter does. The payload field is called
`enteredAtLeast` for that reason and the control room renders it as "at least N".
Treat the door-open event as the reliable signal and the count as corroboration.

---

## Part D - The witness station

One per centre, used only on exam day. This is the ESP32-S3 device.

### D.1 The privacy decision, made explicitly

`docs/06-hardware-spec.md` chose the mmWave sensor precisely so there would be
"no camera anywhere in the design". This device adds one. The resolution is
**scope**, and it is enforced in the firmware rather than promised in a document:

- The camera fires **only** when a fingerprint match succeeds. Never on a timer,
  never on motion, never on a request from the network.
- It captures a single still. There is no streaming path in the code.
- The frame's SHA-256 goes into the ledger; the JPEG goes to the SD card.

The result is a handful of frames per exam of two consenting officials performing
one duty — not hours of a school corridor. Under the DPDP Act 2023 that is the
difference between a narrow, defensible purpose and a surveillance system.

### D.2 Why the fingerprint never leaves the module

The R307 enrols and matches entirely on its own flash. It returns a **slot id**
and a **score**, and that is all the ESP32 ever sees. The ledger records
`"template slot 3 matched, score 187"`. It never holds a fingerprint image or a
template, so a breach of this database cannot leak a biometric that was never in
it.

Enrol locally, per centre, per exam cycle. **Do not touch Aadhaar.**

### D.3 Identifying and wiring your module

Wire colours on these modules are **not a standard**. Red-for-power and
black-for-ground hold almost everywhere; yellow and green swap between batches,
and some units ship with all six leads in white. Do not wire from a colour chart
you found online — read the module.

**Step 1 — find the pinout.** In order of reliability:

1. The silkscreen on the module's own PCB, next to the connector.
2. The label on the JST housing, if the flying lead came with one.
3. A multimeter in continuity mode from each wire back to a labelled pad.

**Step 2 — decide the voltage.** A genuine R307 is the round metal-barrel type
and is marked 4.2-6 V (some list DC 6 V). Modules marked AS608, ZFM-20 or
FPM10A, and most of the flat square black ones, are 3.3 V. If you cannot tell,
start at 3.3 V: an underpowered module fails to answer, which is recoverable,
while an overvolted one is not.

**Step 3 — cross the UART.** This is the mistake that costs the most time. TX
goes to RX and RX goes to TX; wiring TX to TX gives you a module that powers up,
lights its ring, and never answers.

| Module wire | Goes to | Note |
| --- | --- | --- |
| V+ (usually red) | 5V (R307) or 3V3 (AS608) | See step 2 |
| GND (usually black) | GND | Must be common with the ESP32 |
| **TXD** | `PIN_FP_RX` = **GPIO14** | Through the divider if the module is 5 V |
| **RXD** | `PIN_FP_TX` = **GPIO21** | Direct, no divider needed |
| WAKE / touch-out | leave unconnected | The firmware polls; it does not use the interrupt |
| 3V3 touch supply | leave unconnected | Only powers the finger-detect ring |

The two pin names are `PIN_FP_RX` and `PIN_FP_TX` in `station_config.h`. They are
named from the **ESP32's** point of view, which is why `PIN_FP_RX` is the one
that receives the module's TX.

**Step 4 — prove it before building anything on top.**

```bash
pio run -e enrol -t upload
```

```bash
pio device monitor -b 115200
```

A working module prints its template count within a second or two. If it prints
"No fingerprint module on the configured UART pins", work down this list:

| Symptom | Most likely cause |
| --- | --- |
| No response at all, ring dark | Power. Measure V+ to GND at the module itself, not at the supply. |
| Ring lights, no response | TX and RX are not crossed. Swap the two signal wires. |
| Intermittent, garbled bytes | Shared ground missing, or a 5 V module driving the GPIO directly. |
| Answers, then drops out under load | Supply sag. The module draws ~50 mA in bursts; a 500 mA USB port shared with the camera is not enough. |
| Answers on a bench sketch, not this one | Baud. The firmware uses the module default of 57600. |

The `verifyPassword()` call in the firmware is the definitive test — it is a real
handshake with the module, not a guess from the wiring.

### D.4 Wiring — Freenove ESP32-S3-WROOM CAM

The camera consumes sixteen GPIOs and the onboard SD slot three more. These are
the pins that board leaves free.

| Component | Its pin | ESP32-S3 pin | Note |
| --- | --- | --- | --- |
| OV2640 camera | ribbon | — | Onboard |
| microSD | slot | — | Onboard, SDMMC 1-bit |
| DS3231 RTC | VCC / GND | 3V3 / GND | Fit the coin cell |
| | SDA / SCL | **GPIO47** / **GPIO48** | Shared I2C bus |
| SSD1306 OLED 128x64 | VCC / GND | 3V3 / GND | I2C address 0x3C |
| | SDA / SCL | GPIO47 / GPIO48 | |
| R307 fingerprint | VCC / GND | **5V** / GND | 3.3 V for an AS608 part — see D.3 |
| | TX | **GPIO14** | module TX → ESP32 RX, via divider if 5 V |
| | RX | **GPIO21** | module RX ← ESP32 TX, direct |
| Passive buzzer | + / − | **GPIO42** / GND | |
| Abandon button | leg 1 / leg 2 | **GPIO1** / GND | Internal pull-up |
| Status LED | anode | **GPIO2** via 330 Ω | Cathode to GND |

For a XIAO ESP32S3 Sense instead, switch the `#define` in `station_config.h` —
its camera and SD pin map is already in `src/camera_pins.h`. The peripheral pins
above will need reassigning; that board leaves far fewer free.

### D.5 The ceremony the firmware implements

```
superintendent → finger → slot 3, score 187 → frame #1, SHA-256 committed
                                            ↓
                                   OLED: "1 of 2 — 120s left"
                                            ↓
observer       → finger → slot 7, score 203 → frame #2, SHA-256 committed
                                            ↓
                                   OLED: "2 of 2 present — proceeding"
```

Three ways it does not complete, each **recorded rather than discarded**:

| What happens | Recorded as |
| --- | --- |
| Same finger presented twice | `same_finger_twice` |
| Second official never arrives | `window_expired` |
| Someone presses the abandon button | `window_expired` |
| Match below the score threshold | `EXCEPTION_RAISED / biometric_low_confidence` |

One person tapping twice is not two people — the same principle the ledger
enforces when it refuses a co-signature from the signing device itself.

---

## Part E - Building and flashing

### E.1 Bring-up order

Follow the roadmap's sprint order (Part H.1). Each step is a thing that either
works or does not, and skipping ahead makes failures ambiguous.

| Step | Do this | Proves |
| --- | --- | --- |
| 1 | `pio run -e set_clock -t upload`, check the printed time against `date -u` | Toolchain and I2C work |
| 2 | `pio run -e enrol -t upload`, enrol one finger, see slot + score on serial | Biometric path works standalone |
| 3 | Flash `witness`; watch a JPEG appear in `/frames` on the card | Camera and SD work |
| 4 | Read the `frameSha256` on the serial console; hash the file on your laptop | The commitment is real, not asserted |
| 5 | See the signed row appear in the control room | **End to end. This is the demo.** |
| 6 | Two-person window, OLED state, buzzer | The ceremony, not just the sensors |
| 7 | Pull the network cable mid-ceremony, then restore it | Fails closed |

Stop at step 5 if time is short. A fingerprint on a breadboard producing a signed
row in a live control room is worth more than a polished enclosure with nothing
behind it.

### E.2 Provision the device identity

The ledger must be running first (see `RUNNING.md`). Then, per board:

```bash
node tools/provision-device/index.mjs --kind monitor --centre JPR-001
```

It generates an Ed25519 keypair, enrols the **public** half with `POST /devices`,
and prints the private half **once**, formatted as C defines. Paste that block
into `src/monitor_config.h` or `src/station_config.h`, then fill in
`WIFI_SSID`, `WIFI_PASSWORD` and `LEDGER_BASE_URL`.

`LEDGER_BASE_URL` must be the machine's **LAN address**, not `localhost` — the
ESP32 resolves it on its own network.

The private key is printed once and stored nowhere. If you lose it, revoke the
device and provision another. That is cheaper than a recovery mechanism, and a
recovery mechanism is itself a way to steal a device identity.

### E.3 Set the clock

```bash
pio run -e set_clock -t upload
```

Set `BUILD_UTC_OFFSET_MINUTES` in `src/set_clock.cpp` first — it is 330 for IST.
Everything downstream assumes UTC, and a station on local time puts a
five-and-a-half-hour skew inside every signed body and makes the two-person
window meaningless.

**The clock is never corrected from the network at runtime.** The ledger records
device time and server time separately (`clock_skew_ms`) and reconciles neither.
Drift is a finding; a device that quietly rewrites its own clock to match a
server destroys the evidence that the two ever disagreed.

### E.4 Enrol fingers

```bash
pio run -e enrol -t upload
pio device monitor -b 115200
```

**Enrol three fingers per person.** Optical readers fail on dry, worn and
work-hardened hands, which is exactly this workforce. Slots below
`OBSERVER_SLOT_MIN` (default 10) are read as the superintendent, at or above it
as the observer.

Record the slot-to-person mapping in the centre's roster. The ledger will only
ever say "slot 3 matched"; who slot 3 is lives in `ref.person`, not in the chain.

### E.5 Flash and run

```bash
pio run -t upload
```

```bash
pio device monitor -b 115200
```

The firmware **halts with a blinking LED** rather than running if provisioning is
invalid, the DS3231 is missing, or the SD card is unreadable. A monitor whose
signatures cannot verify looks alive on the bench and is invisible in the ledger,
which is the worst of both.

---

## Part F - Integrating with the software

### F.1 What the devices put into the chain

| Kind | From | Already existed |
| --- | --- | --- |
| `MONITOR_HEARTBEAT` | both devices, every 30 s | yes |
| `ROOM_ENTRY` | room monitor | yes |
| `EXCEPTION_RAISED` | both, for degraded sensors | yes |
| `WITNESS_ASSERTED` | witness station | **new** |
| `WITNESS_CEREMONY` | witness station | **new** |

The two new kinds are added in `packages/contracts/src/events.ts`. If you want to
run the witness station against an untouched ledger, set
`USE_WITNESS_EVENT_KINDS 0` in `station_config.h`: the station then reports each
assertion as `ACCESS_REQUESTED` carrying the frame hash in `photoSha256`, which
is a kind and a field that already exist. That is enough for step 5 of the
bring-up order and needs no server change — but the slot and score have nowhere
to go in that shape, which is exactly why the new kinds exist.

After changing contracts, rebuild and **restart the ledger** — it validates
against its compiled schema, so a running instance will reject the new kinds with
`schema_invalid` until it is restarted:

```bash
pnpm build
```

### F.2 Close the heartbeat loop

The firmware's heartbeat rule is only half a rule until something watches for the
gap. `MONITOR_SILENT` is in `SERVICE_ONLY_KINDS` — a monitor cannot report its
own silence, and that asymmetry is deliberate: a device that could declare itself
silent could also decline to.

Provision a service identity and run the watchdog:

```bash
node tools/provision-device/index.mjs --kind service
```

```bash
WATCHDOG_DEVICE_ID=... WATCHDOG_PRIVKEY=... node tools/monitor-watchdog/index.mjs
```

It emits one `MONITOR_SILENT` per outage, not one per poll. A control room
drowning in repeats stops reading them, which is the same as not having raised
the alarm.

### F.3 The six new checks

The 15 software checks are untouched. Six more are evaluated at the `unlock`
stage only, in `services/ledger/src/domain/policy.ts`:

| # | Check | What it establishes |
| --- | --- | --- |
| 16 | `biometric_primary` | A fingerprint matched the superintendent's template |
| 17 | `biometric_secondary` | A **different** template matched — not the same finger twice |
| 18 | `two_person_copresence` | Both assertions fell inside the window |
| 19 | `occupancy_corroborated` | The room monitor's independent count is consistent |
| 20 | `seal_lock_intact` | *Not evaluated — the seal lock is not built* |
| 21 | `witness_capture` | A frame was captured and its hash committed |

Two properties worth knowing before you rely on them:

**They are binding only where the hardware exists.** A centre that has never
produced a witness event does not have a station, and refusing its unlock for
the absence of evidence no device was installed to produce would be a denial
about our procurement rather than about the exam. The checks are recorded either
way and contribute deny reasons only once a centre has demonstrably been fitted.
Existing centres and the seeded data are unaffected.

**An unevaluated check is never reported as passed.** Check 20 records "not
evaluated — the electronic seal lock is not implemented" and fails. A check
nobody ran must not look like a check that succeeded.

The evidence is read from the chain, not queried live from the device. A station
unplugged at 08:51 cannot retract what it signed at 08:50.

### F.4 Where the JPEG goes

The event carries `SHA256(jpeg)`. The JPEG itself is written to `/frames` on the
station's card and uploads when bandwidth allows, or never. This is the same
pattern as the custody key: commit the hash, hold the artefact elsewhere.

- The chain proves the image is the one captured at that moment.
- The chain does not become a photo archive.
- Losing the image later does not break the chain — it only means that one
  commitment can no longer be checked against anything.

---

## Part G - The seal lock (not built)

The ESP32-C6 seal lock is the one device from the roadmap with no code here. It
would need, in this order:

1. Two new event kinds — a tamper-loop state and a monotonic open counter.
2. A pinned authority public key on the device, so it verifies commands rather
   than trusting whoever reaches it.
3. Tamper events written to flash **before** any radio transmission — the same
   rule as the SD spool, for the same reason.
4. Check 20 rewritten against real evidence.

Until then check 20 says so, out loud, on every unlock.

---

## Part H - Honest limits

These belong in the pitch as much as in the source.

- **ESP32 flash is readable.** An attacker with physical access and patience can
  extract the per-device private key and forge records. These devices are
  tamper-evident, not tamper-proof. Move the key into NVS with flash encryption
  and secure boot before any real deployment — that raises the cost of
  extraction without changing a line of the firmware.
- **Optical fingerprint readers are spoofable** with a lifted print and gelatin.
  The correct answer to a judge is "optical in the prototype, capacitive
  (FPC1020 class) in deployment, and the camera frame is the cross-check" — not
  "our sensor cannot be fooled".
- **Footfall counts are floors, not counts.** Two abreast register as one.
- **And the one that matters most:** at Hazaribagh the principal was *authorised*
  to be in that room. Biometrics and occupancy sensing are detective controls
  against unauthorised entry and close to useless against authorised betrayal.
  Build them; do not let them be the story. The story is the ledger.

The argument for the hardware is not that any sensor is trustworthy. It is that
six independent witnesses must be corrupted **consistently**, in a room, in
minutes — and the one layer that cannot be quietly rewritten is the ledger
recording what each of them said at the time.

## Part I - Demo risks, ranked

| Risk | Mitigation |
| --- | --- |
| S3 camera + Wi-Fi + PSRAM contention causes brownouts | The firmware never captures and transmits concurrently; drain happens only while idle. Use a 2 A supply. |
| Optical reader fails on dry or work-hardened fingers | Three fingers per person. WebAuthn stays the primary path; biometrics corroborate, they do not replace. |
| Camera frames are large, rural upload is slow | Only the hash is on the critical path. |
| Clock drift makes the window unreliable | DS3231 is the on-device authority; device and server time are recorded separately and never reconciled. |
| Hardware fails on stage | Seed a completed ceremony beforehand and have the control-room record open in a second tab. Never let a loose jumper wire cost you the presentation. |
