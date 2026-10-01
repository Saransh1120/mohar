# Seal lock

`src/main.cpp` is the source for the ESP32-C6 Arduino sketch at
`../arduino-ide/SealLock/SealLock.ino`. Run `python firmware/sync-arduino.py`
after changes. Copy `seal_config.example.h` to `seal_config.h` in the sketch
folder and provision a unique device signing key plus a pinned authority public
key. Neither private key belongs in Git.

Provision with the control-room operator's session token and the gateway URL:

```sh
LEDGER_URL=http://127.0.0.1:8080 MOHAR_SESSION_TOKEN=... \
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

The normally locked solenoid is de-energised at boot and on fault. `OPEN`
commands carry an Ed25519 signature, a one-use increasing counter and an expiry
at most 60 seconds away. The board checks all three, the tamper loop, RTC and
flash spool before energising the driver. It writes the counter to NVS first.
Tamper transitions and lock actions are signed to the ledger and stored in
LittleFS before any network send. A failed flash write disables the lock until
service. The device never formats a failed flash partition automatically.

The UART protocol and signed bytes are specified at the top of the sketch.
After migration 010, `tools/seal-lock-command/index.mjs --attempt <uuid>` checks
that the access engine granted a recent `unlock`, records a unique command and
signs its 30-second UART line. Keep the authority seed outside Git and on an
operator-controlled machine; the tool prints the command only after its audit
row commits. The board accepts increasing counters, so a command that expires
before delivery does not prevent later commands. Sending the line to the
board's UART and operational custody of that authority key still need setup.

This has not been compiled for or electrically tested on a physical ESP32-C6.
Before field use, test driver polarity, power-loss locking, tamper transitions,
counter persistence and flash write failure on the actual board. Enable ESP32
secure boot and flash encryption so the pinned key and signing identity cannot
be replaced by reflashing the board.
