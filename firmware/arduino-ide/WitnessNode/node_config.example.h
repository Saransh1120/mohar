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
#define WIFI_SSID       "CHANGE_ME"
#define WIFI_PASSWORD   "CHANGE_ME"
// The LAN address of the machine running the ledger. NOT localhost — the ESP32
// resolves this on its own network.
#define LEDGER_BASE_URL "http://CHANGE_ME:8081"

// ── identity (from tools/provision-device) ─────────────────────────────────
#define DEVICE_ID       "CHANGE_ME"
#define DEVICE_PRIVKEY  "CHANGE_ME"
#define DEVICE_PUBKEY   "CHANGE_ME"

// ── what this node is witnessing ───────────────────────────────────────────
#define EXAM_ID         "166a2cd5-b4d7-48d4-9f31-cc55967244ad"
#define CENTRE_ID       "3a790600-c3f4-45bb-b400-675f699d24e0"
// Leave "" to omit packageId from the signed body — omitted, never null.
#define PACKAGE_ID      "43699841-8d9f-4f2f-b50b-848623896066"

// ── asking for the unlock decision ─────────────────────────────────────────
// After a two-person window closes successfully the node asks the access engine
// whether this package may be opened, and signals the answer on the buzzer.
// The engine records the attempt before it answers, so the request itself is
// evidence whether it is granted or refused.
#define REQUEST_ACCESS_AFTER_CEREMONY 0
#define ACCESS_STAGE "unlock"
// The custody key for this stage and epoch, from POST /keys/issue. Leave empty
// and the engine will refuse for `key_not_presented` — which is the correct
// refusal, and a perfectly good thing to demonstrate.
#define CUSTODY_KEY     "CHANGE_ME"

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
