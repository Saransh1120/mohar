#pragma once

/**
 * ── Per-device provisioning for the witness station ──────────────────────────
 *
 * Fill this in from `node tools/provision-device/index.mjs`, which generates the
 * keypair, enrols the public half with `POST /devices` and prints this block
 * ready to paste.
 *
 * The private key sits in plain flash, and `docs/06-hardware-spec.md` already
 * says out loud what that means: "ESP32 flash is readable ... tamper-evident,
 * not tamper-proof". Before a real deployment move it into NVS and enable flash
 * encryption and secure boot. That raises the cost of extraction without
 * changing a line of the firmware.
 */

// ── network ────────────────────────────────────────────────────────────────
#define WIFI_SSID       "CHANGE_ME"
#define WIFI_PASSWORD   "CHANGE_ME"
#define LEDGER_BASE_URL "http://192.168.1.10:8081"

// ── identity (from tools/provision-device) ─────────────────────────────────
#define DEVICE_ID       "00000000-0000-4000-8000-000000000000"
#define DEVICE_PRIVKEY  "0000000000000000000000000000000000000000000000000000000000000000"
#define DEVICE_PUBKEY   "0000000000000000000000000000000000000000000000000000000000000000"

// ── what this station is witnessing ────────────────────────────────────────
#define EXAM_ID         "00000000-0000-4000-8000-000000000000"
#define CENTRE_ID       "00000000-0000-4000-8000-000000000000"
// The package whose seal this station witnesses being opened. Leave as "" to
// omit `packageId` from the signed body — omitted, never null (see mohar_event.h).
#define PACKAGE_ID      ""

/**
 * Emit the new WITNESS_ASSERTED / WITNESS_CEREMONY kinds.
 *
 * Set to 0 to run against an unmodified ledger: the station then reports each
 * assertion as ACCESS_REQUESTED carrying the frame hash in `photoSha256`, which
 * is a kind and a field that already exist. That is step 5 of the sprint order
 * in the roadmap — a fingerprint on a breadboard producing a signed row in a
 * live control room — and it needs no server change at all. Set it to 1 once the
 * contract additions in docs/12 have been applied.
 */
#define USE_WITNESS_EVENT_KINDS 1

// ── the two-person rule ────────────────────────────────────────────────────
// Both assertions must fall inside this window for `two_person_copresence` to
// hold. 120 s is the figure the roadmap uses.
#define CEREMONY_WINDOW_SECONDS 120
// Enrolled template slots below this belong to the superintendent, at or above
// it to the observer. Enrol three fingers per person: optical readers fail on
// dry and work-hardened hands, which is exactly this workforce.
#define OBSERVER_SLOT_MIN 10
// Refuse a match this weak rather than record it. The R307 reports confidence
// roughly 0..255; anything under ~60 is noise.
#define MIN_MATCH_SCORE 60

#define HEARTBEAT_SECONDS 30

// ── camera board ───────────────────────────────────────────────────────────
// Pick exactly one. The pin maps live in camera_pins.h.
#define CAMERA_MODEL_FREENOVE_S3 1
// #define CAMERA_MODEL_XIAO_ESP32S3 1

// ── pins (Freenove ESP32-S3-WROOM CAM; see docs/12 for the wiring table) ───
// These are the GPIOs that board leaves free once the camera and its SDMMC
// slot have taken theirs.
#define PIN_I2C_SDA   47   // DS3231 + SSD1306
#define PIN_I2C_SCL   48
#define PIN_FP_RX     14   // ESP32 RX  <- R307 TX  (green)
#define PIN_FP_TX     21   // ESP32 TX  -> R307 RX  (yellow)
#define PIN_BUZZER    42
#define PIN_BUTTON     1   // to GND, INPUT_PULLUP — abandons a ceremony
#define PIN_LED        2

#define OLED_I2C_ADDR 0x3C
