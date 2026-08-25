# room-monitor

ESP32 firmware for the strong-room / control-room monitor. The only hardware in
the project, and deliberately simple: no secure element, no latch, no custom PCB.

Senses door state (reed switch), presence (HLK-LD2410C mmWave, no imaging),
footfall direction and count (two VL53L0X ToF sensors in the doorway), and
ambient light. Timestamps from a DS3231 RTC, buffers to microSD, syncs over
Wi-Fi or - where the school has none - over BLE when the field app visits.

Target bill of materials is under Rs 1,200 per unit.

Two firmware rules carry most of the value: a 30-second heartbeat, so that
unplugging the device raises an alarm rather than going dark; and writing to SD
*before* transmitting, so cutting power or jamming Wi-Fi cannot erase the record.

Tamper-evident, not tamper-proof - ESP32 flash is readable and the per-device
HMAC key is extractable by anyone with physical access and patience.

Wiring, bring-up order and integration steps: `docs/12-hardware-build-guide.md`.
Design rationale: `docs/06-hardware-spec.md`.

Note that records are signed with **Ed25519**, not HMAC as `docs/06` states.
The ledger has only ever had one entrance and it verifies Ed25519 over the
canonical body; see `docs/12` Part A for why that correction was made rather
than adding a second, monitor-shaped ingest path.
