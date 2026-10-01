/**
 * ESP32-C6 package seal lock. Arduino IDE sketch.
 *
 * A command is one ASCII line on the service UART:
 *   OPEN|decision-attempt-uuid|next-counter|valid-until-unix|128-lowercase-hex-signature
 * Signature: Ed25519 over the exact ASCII bytes
 *   MOHAR-SEAL-LOCK-v1|package-uuid|decision-attempt-uuid|next-counter|valid-until-unix
 * The authority key is pinned in seal_config.h. A replay, expired command, bad
 * signature, open tamper loop or unavailable flash spool never energises the coil.
 * The counter is persisted before energising it. Default and reset state is locked.
 */
#include <Arduino.h>
#include <Ed25519.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>

#include <mohar_crypto.h>
#include <mohar_event.h>
#include <mohar_net.h>
#include <mohar_spool.h>
#include <mohar_time.h>
#include "seal_config.h"

using namespace mohar;

static Identity g_id;
static Clock g_clock;
static Spool g_spool;
static Ledger g_ledger;
static Preferences g_nvs;
static uint8_t g_authority[32];
static uint32_t g_counter = 0;
static bool g_tamperOpen = false;
static bool g_open = false;
static uint32_t g_openMs = 0;
static uint32_t g_lastDrain = 0;
static bool g_ready = false;
static bool g_fault = false;

static void coil(bool energise) {
  digitalWrite(SOLENOID_PIN, energise == bool(SOLENOID_ACTIVE_HIGH) ? HIGH : LOW);
}

static bool tamperOpen() { return digitalRead(TAMPER_PIN) == TAMPER_OPEN_LEVEL; }
static bool reedClosed() { return digitalRead(REED_PIN) == REED_CLOSED_LEVEL; }

/** Fail closed if a signed record cannot first be kept in flash. */
static bool record(const char *kind, const String &payload) {
  char at[25], eventId[37];
  g_clock.nowIso(at);
  uuid4(eventId);
  String line = signedEvent(g_id, kind, at, eventId, payload.c_str());
  if (line.isEmpty() || !g_spool.append(at, line)) {
    g_fault = true;
    Serial.println("[seal] flash spool unavailable; lock disabled");
    return false;
  }
  return true;
}

static bool recordTamper(bool open) {
  JsonWriter p;
  p.str("deviceId", DEVICE_ID);
  p.num("sequence", g_counter);
  p.boolean("tamperSwitchOpen", open);
  return record("ENCLOSURE_OPENED", p.done());
}

static bool recordOpened(const char *decisionId) {
  JsonWriter p;
  p.num("commandCounter", g_counter);
  p.str("decisionAttemptId", decisionId);
  p.str("deviceId", DEVICE_ID);
  p.str("packageId", PACKAGE_ID);
  p.boolean("reedSwitchClosed", reedClosed());
  return record("SEAL_LOCK_OPENED", p.done());
}

static void recordClosed(uint32_t seconds) {
  JsonWriter p;
  p.str("deviceId", DEVICE_ID);
  p.num("openSeconds", seconds);
  p.str("packageId", PACKAGE_ID);
  p.boolean("reedSwitchClosed", reedClosed());
  record("SEAL_LOCK_CLOSED", p.done());
}

static bool uuid(const String &s) {
  if (s.length() != 36) return false;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (s[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(s[i]))) return false;
  }
  return true;
}

static void command(String line) {
  line.trim();
  if (line.length() > 240 || !line.startsWith("OPEN|")) return;
  int a = line.indexOf('|', 5);
  int b = a < 0 ? -1 : line.indexOf('|', a + 1);
  int c = b < 0 ? -1 : line.indexOf('|', b + 1);
  if (a < 0 || b < 0 || c < 0 || line.indexOf('|', c + 1) >= 0) return;
  String decision = line.substring(5, a);
  String countText = line.substring(a + 1, b);
  String expiryText = line.substring(b + 1, c);
  String sigText = line.substring(c + 1);
  if (!uuid(decision) || countText.isEmpty() || expiryText.isEmpty() || sigText.length() != 128) return;
  for (size_t i = 0; i < countText.length(); ++i) if (!isdigit(static_cast<unsigned char>(countText[i]))) return;
  for (size_t i = 0; i < expiryText.length(); ++i) if (!isdigit(static_cast<unsigned char>(expiryText[i]))) return;
  uint64_t next = strtoull(countText.c_str(), nullptr, 10);
  uint64_t expiry = strtoull(expiryText.c_str(), nullptr, 10);
  uint32_t now = g_clock.unixTime();
  // An issued command may expire without being delivered. Skipped counters are
  // safe; only reuse or rollback is forbidden.
  if (next <= g_counter || next > UINT32_MAX || expiry < now || expiry > uint64_t(now) + 60) return;
  if (g_open || g_fault || tamperOpen() || !g_spool.healthy() || g_clock.lostPower()) return;

  uint8_t signature[64];
  if (!hexToBytes(sigText.c_str(), signature, sizeof(signature))) return;
  String message = String("MOHAR-SEAL-LOCK-v1|") + PACKAGE_ID + "|" + decision + "|" + countText + "|" + expiryText;
  if (!Ed25519::verify(signature, g_authority, message.c_str(), message.length())) return;

  // This NVS write must succeed before actuation. A reset cannot replay the command.
  if (g_nvs.putULong("counter", static_cast<uint32_t>(next)) != sizeof(uint32_t)) return;
  g_counter = static_cast<uint32_t>(next);
  // The signed audit record must survive a power cut before power reaches the coil.
  if (!recordOpened(decision.c_str())) return;
  coil(true);
  g_open = true;
  g_openMs = millis();
  Serial.printf("[seal] authorised pulse, counter=%u\n", g_counter);
}

void setup() {
  pinMode(SOLENOID_PIN, OUTPUT);
  coil(false);
  pinMode(TAMPER_PIN, INPUT_PULLUP);
  pinMode(REED_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.setTimeout(100);
  if (!LittleFS.begin(false) || !g_spool.begin(LittleFS, "/mohar")) {
    Serial.println("[seal] flash unavailable; remaining locked");
    return;
  }
  if (!g_clock.begin() || g_clock.lostPower()) {
    Serial.println("[seal] RTC missing or lost power; remaining locked");
    return;
  }
  if (!identityFromHex(g_id, DEVICE_ID, EXAM_ID, CENTRE_ID, PACKAGE_ID,
                       DEVICE_PRIVATE_KEY_HEX, DEVICE_PUBLIC_KEY_HEX) ||
      strlen(AUTHORITY_PUBLIC_KEY_HEX) != 64 ||
      !hexToBytes(AUTHORITY_PUBLIC_KEY_HEX, g_authority, 32)) {
    Serial.println("[seal] identity or authority key invalid; remaining locked");
    return;
  }
  if (!g_nvs.begin("seal-lock", false)) {
    Serial.println("[seal] counter storage unavailable; remaining locked");
    return;
  }
  g_counter = g_nvs.getULong("counter", 0);
  g_tamperOpen = tamperOpen();
  if (g_tamperOpen) recordTamper(true);
  g_ledger.begin(LEDGER_URL);
  g_ready = true;
  wifiConnect(WIFI_SSID, WIFI_PASSWORD, 3000);
}

void loop() {
  if (!g_ready || g_fault || g_clock.lostPower()) { coil(false); delay(100); return; }
  if (!g_spool.healthy()) { coil(false); delay(100); return; }
  bool open = tamperOpen();
  if (open != g_tamperOpen) {
    g_tamperOpen = open;
    // Durable before any radio call; if the write fails, disable actuation.
    if (!recordTamper(open)) coil(false);
  }
  if (g_open && (open || millis() - g_openMs >= 5000)) {
    coil(false);
    g_open = false;
    recordClosed((millis() - g_openMs) / 1000);
  }
  if (Serial.available()) command(Serial.readStringUntil('\n'));
  if (millis() - g_lastDrain >= 1000) {
    g_lastDrain = millis();
    if (WiFi.status() != WL_CONNECTED) wifiConnect(WIFI_SSID, WIFI_PASSWORD, 100);
    g_ledger.drain(g_spool, 3);
  }
  delay(20);
}
