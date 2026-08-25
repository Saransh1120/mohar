# witness-station

ESP32-S3 firmware for the unlock ceremony. One per centre, used only on exam day.

At the moment the sealed bundle is opened it establishes that two *different*
enrolled people were physically present, and commits a photograph of that moment
to the ledger by hash.

- The camera fires **only** on a successful fingerprint match. Never on a timer,
  never on motion. There is no streaming path in the code.
- The fingerprint template never leaves the R307 module. The ledger records
  "slot 3 matched, score 187" — a match result, not a biometric.
- The event carries `SHA256(jpeg)`; the JPEG goes to the SD card. Commit the
  hash, hold the artefact elsewhere.

Three PlatformIO environments:

| Env | Purpose |
| --- | --- |
| `witness` | The station itself. The default. |
| `enrol` | Enrol fingerprints over the serial monitor. Run once per person. |
| `set_clock` | Set the DS3231 from the host clock, once. |

Wiring, bring-up order and integration steps: `docs/12-hardware-build-guide.md`.

Tamper-evident, not tamper-proof — the per-device signing key is in readable
flash, and an optical reader is spoofable with a lifted print. Both limits are
stated in `docs/12` Part H and should be stated in the pitch too.
