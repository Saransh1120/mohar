#pragma once

/**
 * ── Per-device provisioning ──────────────────────────────────────────────────
 *
 * Fill this in from the output of `node tools/provision-device/index.mjs`, which
 * generates the keypair, enrols the public half with `POST /devices` and prints
 * this block ready to paste. Each board gets its own device id and its own key;
 * two boards sharing a key would let one device sign as the other, which is the
 * same failure the ledger refuses when it rejects a co-signature from the
 * signing device itself.
 *
 * The private key sits in plain flash. `docs/06-hardware-spec.md` already says
 * this out loud — "ESP32 flash is readable ... tamper-evident, not tamper-proof"
 * — and putting the key here rather than pretending otherwise keeps the code
 * honest with the threat model. Before a real deployment, move it into NVS and
 * turn on flash encryption and secure boot; that raises the cost of extraction
 * without changing a line of the code below.
 */

// ── network ────────────────────────────────────────────────────────────────
#define WIFI_SSID       "CHANGE_ME"
#define WIFI_PASSWORD   "CHANGE_ME"
#define LEDGER_BASE_URL "http://192.168.1.10:8081"

// ── identity (from tools/provision-device) ─────────────────────────────────
#define DEVICE_ID       "00000000-0000-4000-8000-000000000000"
#define DEVICE_PRIVKEY  "0000000000000000000000000000000000000000000000000000000000000000"
#define DEVICE_PUBKEY   "0000000000000000000000000000000000000000000000000000000000000000"

// ── what this monitor is watching ──────────────────────────────────────────
#define EXAM_ID         "00000000-0000-4000-8000-000000000000"
#define CENTRE_ID       "00000000-0000-4000-8000-000000000000"

// ── running without a card ─────────────────────────────────────────────────
// Set to 1 to let the device run with no microSD, buffering in RAM instead.
//
// This gives up the write-before-transmit guarantee: a power cut or a long
// network outage loses whatever is still buffered. It is fine on the bench and
// defensible in a pinch, but it is a downgrade and the device says so in the
// ledger on every boot rather than pretending otherwise. Set it back to 0 once
// a card is fitted.
#define ALLOW_NO_SD 1
#define RAM_SPOOL_RECORDS 40

// ── which sensors are actually fitted ──────────────────────────────────────
//
// Set to 0 for anything not physically present.
//
// This is not a convenience switch. `ROOM_ENTRY` requires `doorOpen` and
// `lightOn` as booleans — the contract has no way to say "not measured" — so an
// unfitted sensor would otherwise put a fabricated `false` inside a signed body,
// and a signed lie is worse than no record at all. With the flag off, the device
// still sends the field but announces the absence once per boot, so anyone
// reading the chain can see that the value carries no information.
#define HAVE_REED 1
#define HAVE_LDR  0
#define HAVE_LD2410 1
#define HAVE_TOF  1

// ── timing ─────────────────────────────────────────────────────────────────
// 30 s to match MONITOR_HEARTBEAT_SECONDS in .env.example. The server-side
// watchdog derives MONITOR_SILENT from the absence of these.
#define HEARTBEAT_SECONDS 30

// ── pins (ESP32-WROOM-32) ──────────────────────────────────────────────────
#define PIN_REED        27   // reed switch to GND; INPUT_PULLUP, LOW = magnet near = closed
#define PIN_LDR         34   // ADC1 only — ADC2 is unusable while Wi-Fi is on
#define PIN_I2C_SDA     21
#define PIN_I2C_SCL     22
#define PIN_TOF_OUTER_XSHUT 25
#define PIN_TOF_INNER_XSHUT 26
#define PIN_LD2410_RX   16   // ESP32 RX  <- LD2410C TX
#define PIN_LD2410_TX   17   // ESP32 TX  -> LD2410C RX
#define PIN_SD_CS        5
#define PIN_LED          2

// ── thresholds ─────────────────────────────────────────────────────────────
// A beam is "broken" when something is closer than this. Set it to roughly two
// thirds of the doorway width so the far jamb does not read as a person.
#define TOF_BREAK_MM        900
// How long the two beams may be apart and still count as one person passing.
#define TOF_PAIR_WINDOW_MS  1500
// Below this raw ADC reading the room is dark. Calibrate on site: this is a
// bare LDR divider, not a photometer.
#define LDR_DARK_BELOW      800
