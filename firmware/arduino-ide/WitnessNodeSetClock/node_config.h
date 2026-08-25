#pragma once

/**
 * ── Per-device provisioning ──────────────────────────────────────────────────
 *
 * Fill this in from `node tools/provision-device/index.mjs`, which generates the
 * keypair, enrols the public half with `POST /devices` and prints this block
 * ready to paste.
 *
 * The private key sits in plain flash. `docs/06-hardware-spec.md` already says
 * what that means — "ESP32 flash is readable ... tamper-evident, not
 * tamper-proof" — and putting it here rather than pretending otherwise keeps the
 * code honest with the threat model.
 */

// ── network ────────────────────────────────────────────────────────────────
#define WIFI_SSID       "Hello"
#define WIFI_PASSWORD   "12345678"
// The LAN address of the machine running the ledger. NOT localhost — the ESP32
// resolves this on its own network.
#define LEDGER_BASE_URL "http://10.91.155.116:8081"

// ── identity (from tools/provision-device) ─────────────────────────────────
#define DEVICE_ID       "f5f3d5ad-905f-494f-8d2a-33a391645a90"
#define DEVICE_PRIVKEY  "135a6ebe4e2f57d198d1c4666cf7cc1c3babf6d322b1a21b4c63fb1d143c0719"
#define DEVICE_PUBKEY   "a593acbd8e8868b304fce8f7cfa0774d043e266f9b5f59d2de518e2b2cd766eb"

// ── what this node is witnessing ───────────────────────────────────────────
#define EXAM_ID         "3596046e-f003-4e4b-bce3-dfa1564d7459"
#define CENTRE_ID       "10adf6d5-735d-4bf3-bfc1-b54a97e520be"
// Leave "" to omit packageId from the signed body — omitted, never null.
#define PACKAGE_ID      ""

// ── the two-person rule ────────────────────────────────────────────────────
// Both assertions must fall inside this window for two_person_copresence.
#define CEREMONY_WINDOW_SECONDS 120
// Slots below this are the superintendent, at or above it the observer.
// Enrol three fingers per person: optical readers fail on dry and
// work-hardened hands, which is exactly this workforce.
#define OBSERVER_SLOT_MIN 10
// Refuse a match this weak rather than record it as an assertion. The R307
// reports confidence roughly 0..255; under ~60 is noise.
#define MIN_MATCH_SCORE 60

#define HEARTBEAT_SECONDS 30
#define RAM_SPOOL_RECORDS 40

// ── pins (classic ESP32-WROOM-32 devkit) ───────────────────────────────────
#define PIN_I2C_SDA   21   // DS3231
#define PIN_I2C_SCL   22
#define PIN_FP_RX     32   // ESP32 RX  <- R307 TXD (through the divider if 5V)
#define PIN_FP_TX     33   // ESP32 TX  -> R307 RXD
#define PIN_BUZZER    25
#define PIN_LED        2

#define HAVE_BUZZER 1
