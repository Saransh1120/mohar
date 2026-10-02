# Seal lock

`src/main.cpp` is the source for the ESP32-C6 Arduino sketch at
`../arduino-ide/SealLock/SealLock.ino`. Run `python firmware/sync-arduino.py`
after changes. Copy `seal_config.example.h` to `seal_config.h` in the sketch
folder and provision a unique device signing key plus a pinned authority public
key. Neither private key belongs in Git.

Provision with the control-room operator's session token and the gateway URL:

```sh
LEDGER_URL=http://127.0.0.1:8081 MOHAR_SESSION_TOKEN=... \
SEAL_LOCK_AUTHORITY_PUBLIC_KEY_HEX=... \
node tools/provision-device/index.mjs --kind monitor --sketch seal \
  --centre JPR-001 --package <package-uuid>
```

The tool prints the seal-specific defines; add the Wi-Fi settings, gateway URL
and GPIO polarity from `seal_config.example.h`. The `monitor` registry kind is
used until the device registry has a dedicated seal-lock kind. Install the
ESP32-C6 Arduino board support, the shared `Mohar` library, and the Arduino
Ed25519 library used by `Ed25519.h`. Provision LittleFS before the first boot;
the sketch deliberately does not format flash after a failure.

Copy `firmware/arduino-ide/libraries/Mohar` into the Arduino sketchbook's
`libraries` folder again whenever the shared sources change. The IDE compiles
against the installed copy, not the one in this repository, and an installed
copy that is behind signs or sends differently from what was reviewed.

## What the board does

The normally locked solenoid is de-energised at boot and on fault. `OPEN`
commands carry an Ed25519 signature, a one-use increasing counter and an expiry
at most 60 seconds away. The board checks all three, the tamper loop, RTC and
flash spool before energising the driver. It writes the counter to NVS first.
Tamper transitions and lock actions are signed to the ledger and stored in
LittleFS before any network send. A failed flash write disables the lock until
service. The device never formats a failed flash partition automatically.

The coil is held for `SOLENOID_PULSE_MS` (5 s by default, 10 s at most) and is
switched off by two independent things: the main loop, and a one-shot hardware
timer armed before the coil is energised. While the coil is on the board does
not join Wi-Fi or make an HTTP request, so a ledger that does not answer cannot
keep it energised. A refused command is reported on the UART with the reason
and leaves no signed record.

The UART protocol and signed bytes are specified at the top of the sketch.
After migration 010, `tools/seal-lock-command/index.mjs --attempt <uuid>` checks
that the access engine granted a recent `unlock`, records a unique command and
signs its 30-second UART line. Keep the authority seed outside Git and on an
operator-controlled machine; the tool prints the command only after its audit
row commits. The board accepts increasing counters, so a command that expires
before delivery does not prevent later commands. Sending the line to the
board's UART and operational custody of that authority key still need setup.

## Wiring that firmware cannot make safe

- **A pull resistor on the driver's gate.** 10 k from the gate of the MOSFET (or
  the input of the driver) to the de-energised level. While the chip is in
  reset, booting or being flashed its GPIOs float, and no code is running to
  hold the coil off.
- **A flyback diode across the coil**, and the coil on its own supply rail, not
  the board's 3.3 V regulator. A solenoid pulling in from the same rail browns
  the chip out.
- **Not a strapping pin.** GPIO 4, 5, 8, 9 and 15 decide how the ESP32-C6 boots.
  The sketch refuses to compile with the solenoid on one of them. Keep 12 and
  13 (USB), 16 and 17 (the UART the commands arrive on) and 22 and 23 (I2C to
  the DS3231) free as well.
- **A solenoid rated for the pulse.** `SOLENOID_PULSE_MS` must be inside its
  rated on-time at the supply voltage used.

## What has and has not been checked

Compiled for `esp32:esp32:esp32c6` with arduino-cli 1.5.1, ESP32 core 3.3.11,
Crypto 0.4.0 and RTClib 2.1.4, warnings on, none raised: 447294 bytes (34% of
program storage), 22204 bytes of globals.

No board was available. Nothing below has been done, and each needs the actual
board, driver and solenoid:

- driver polarity, and that the gate's pull resistor keeps the coil off through
  reset and through flashing;
- the pulse length measured on a scope, and the coil's temperature over
  repeated pulses;
- that the hardware timer cuts the coil when the loop is held up;
- brown-out when the coil pulls in;
- power cut during a pulse, and between the counter write and the pulse;
- the tamper loop opening during a pulse;
- counter persistence across resets, and a replayed command being refused;
- a full or failed LittleFS partition, and a DS3231 that has lost power;
- a command delivered over a real UART from `tools/seal-lock-command`;
- ESP32 secure boot and flash encryption, without which the pinned key and the
  signing identity can be replaced by reflashing the board.
