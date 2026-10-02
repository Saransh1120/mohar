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
 *
 * The coil is switched off by two things that do not depend on each other: the
 * main loop, at SOLENOID_PULSE_MS, and a one-shot hardware timer armed before
 * the coil is energised. If the loop stalls, the timer still cuts the coil.
 * While the coil is energised the board does nothing that can block: no Wi-Fi
 * join and no HTTP, because a ledger that does not answer holds a request for
 * seconds and a solenoid held that long overheats.
 *
 * Firmware cannot hold the driver off while the chip is in reset or being
 * flashed: the pin floats then. The driver's gate needs its own pull resistor
 * to the de-energised level. See the README.
 */
#include <Arduino.h>
#include <Ed25519.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <driver/gpio.h>
#include <esp_timer.h>

#include <mohar_crypto.h>
#include <mohar_event.h>
#include <mohar_net.h>
#include <mohar_spool.h>
#include <mohar_time.h>
#include "seal_config.h"

using namespace mohar;

/** How long an authorised command holds the coil. */
#ifndef SOLENOID_PULSE_MS
#define SOLENOID_PULSE_MS 5000
#endif
static_assert(SOLENOID_PULSE_MS >= 200 && SOLENOID_PULSE_MS <= 10000,
              "SOLENOID_PULSE_MS must be between 200 and 10000");
static_assert(SOLENOID_PIN != TAMPER_PIN && SOLENOID_PIN != REED_PIN && TAMPER_PIN != REED_PIN,
              "the solenoid, tamper and reed pins must be three different GPIOs");
// ESP32-C6 strapping pins. A driver or a switch on one of these can change how
// the chip boots, and the chip drives some of them itself during boot.
static_assert(SOLENOID_PIN != 4 && SOLENOID_PIN != 5 && SOLENOID_PIN != 8 &&
              SOLENOID_PIN != 9 && SOLENOID_PIN != 15,
              "SOLENOID_PIN is an ESP32-C6 strapping pin; choose another GPIO");

static Identity g_id;
static Clock g_clock;
static Spool g_spool;
static Ledger g_ledger;
static Preferences g_nvs;
static esp_timer_handle_t g_cutoff = nullptr;
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

/** Runs in the timer task, whatever the main loop is doing. */
static void cutoff(void *) { coil(false); }

static bool tamperOpen() { return digitalRead(TAMPER_PIN) == TAMPER_OPEN_LEVEL; }
static bool reedClosed() { return digitalRead(REED_PIN) == REED_CLOSED_LEVEL; }

/** Fail closed if a signed record cannot first be kept in flash. */
static bool record(const char *kind, JsonWriter &payload) {
  char at[25], eventId[37];
  g_clock.nowIso(at);
  uuid4(eventId);
  String line = payload.broken() ? String() : signedEvent(g_id, kind, at, eventId, payload.done().c_str());
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
  return record("ENCLOSURE_OPENED", p);
}

static bool recordOpened(const char *decisionId) {
  JsonWriter p;
  p.num("commandCounter", g_counter);
  p.str("decisionAttemptId", decisionId);
  p.str("deviceId", DEVICE_ID);
  p.str("packageId", PACKAGE_ID);
  p.boolean("reedSwitchClosed", reedClosed());
  return record("SEAL_LOCK_OPENED", p);
}

static void recordClosed(uint32_t seconds) {
  JsonWriter p;
  p.str("deviceId", DEVICE_ID);
  p.num("openSeconds", seconds);
  p.str("packageId", PACKAGE_ID);
  p.boolean("reedSwitchClosed", reedClosed());
  record("SEAL_LOCK_CLOSED", p);
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

/** Said on the service UART only. A refused command leaves no signed record. */
static void refused(const char *why) {
  Serial.print("[seal] command refused: ");
  Serial.println(why);
}

static void command(String line) {
  line.trim();
  if (!line.startsWith("OPEN|")) return;
  int a = line.indexOf('|', 5);
  int b = a < 0 ? -1 : line.indexOf('|', a + 1);
  int c = b < 0 ? -1 : line.indexOf('|', b + 1);
  if (a < 0 || b < 0 || c < 0 || line.indexOf('|', c + 1) >= 0) return refused("not five fields");
  String decision = line.substring(5, a);
  String countText = line.substring(a + 1, b);
  String expiryText = line.substring(b + 1, c);
  String sigText = line.substring(c + 1);
  if (!uuid(decision) || countText.isEmpty() || countText.length() > 10 || expiryText.isEmpty() ||
      expiryText.length() > 10 || sigText.length() != 128) {
    return refused("a field is the wrong shape");
  }
  for (size_t i = 0; i < countText.length(); ++i) if (!isdigit(static_cast<unsigned char>(countText[i]))) return refused("counter is not a number");
  for (size_t i = 0; i < expiryText.length(); ++i) if (!isdigit(static_cast<unsigned char>(expiryText[i]))) return refused("expiry is not a number");
  uint64_t next = strtoull(countText.c_str(), nullptr, 10);
  uint64_t expiry = strtoull(expiryText.c_str(), nullptr, 10);
  uint32_t now = g_clock.unixTime();
  // An issued command may expire without being delivered. Skipped counters are
  // safe; only reuse or rollback is forbidden.
  if (next <= g_counter || next > UINT32_MAX) return refused("counter already used");
  if (expiry < now || expiry > uint64_t(now) + 60) return refused("expired, or valid for more than 60 s");
  if (g_open) return refused("the coil is already energised");
  if (g_fault || !g_spool.healthy() || g_clock.lostPower()) return refused("the board is in a fault state");
  if (tamperOpen()) return refused("the tamper loop is open");

  uint8_t signature[64];
  if (!hexToBytes(sigText.c_str(), signature, sizeof(signature))) return refused("signature is not hex");
  String message = String("MOHAR-SEAL-LOCK-v1|") + PACKAGE_ID + "|" + decision + "|" + countText + "|" + expiryText;
  if (!Ed25519::verify(signature, g_authority, message.c_str(), message.length())) return refused("signature does not verify");

  // This NVS write must succeed before actuation. A reset cannot replay the command.
  if (g_nvs.putULong("counter", static_cast<uint32_t>(next)) != sizeof(uint32_t)) return refused("counter could not be stored");
  g_counter = static_cast<uint32_t>(next);
  // The cut-off is armed before the coil is energised, so there is no moment
  // at which the coil is on and nothing independent is waiting to turn it off.
  if (esp_timer_start_once(g_cutoff, (uint64_t(SOLENOID_PULSE_MS) + 250) * 1000ULL) != ESP_OK) {
    return refused("the cut-off timer could not be armed");
  }
  // The signed audit record must survive a power cut before power reaches the coil.
  if (!recordOpened(decision.c_str())) {
    esp_timer_stop(g_cutoff);
    return;
  }
  coil(true);
  g_open = true;
  g_openMs = millis();
  Serial.printf("[seal] authorised pulse, counter=%lu\n", static_cast<unsigned long>(g_counter));
}

/**
 * Take bytes from the UART without waiting for them. A line longer than a
 * command can be is dropped whole, up to its newline, rather than truncated
 * into something that might parse.
 */
static void pollUart() {
  static char line[241];
  static size_t len = 0;
  static bool overrun = false;
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (len > 0 && !overrun) {
        line[len] = '\0';
        command(String(line));
      }
      len = 0;
      overrun = false;
    } else if (len < sizeof(line) - 1) {
      line[len++] = static_cast<char>(ch);
    } else {
      overrun = true;
    }
  }
}

void setup() {
  // The output latch is set before the pin becomes an output, so an active-low
  // driver is not driven to "energised" for the instant between the two calls.
  // (digitalWrite does nothing to a pin that is not yet an output.)
  gpio_set_level(static_cast<gpio_num_t>(SOLENOID_PIN), SOLENOID_ACTIVE_HIGH ? 0 : 1);
  pinMode(SOLENOID_PIN, OUTPUT);
  coil(false);
  pinMode(TAMPER_PIN, INPUT_PULLUP);
  pinMode(REED_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  esp_timer_create_args_t timer = {};
  timer.callback = &cutoff;
  timer.name = "seal-cutoff";
  if (esp_timer_create(&timer, &g_cutoff) != ESP_OK) {
    Serial.println("[seal] cut-off timer unavailable; remaining locked");
    return;
  }
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
  if (g_open && (open || millis() - g_openMs >= static_cast<uint32_t>(SOLENOID_PULSE_MS))) {
    coil(false);
    esp_timer_stop(g_cutoff);
    g_open = false;
    recordClosed((millis() - g_openMs) / 1000);
  }
  pollUart();
  // Nothing that can block while the coil is energised: see the note at the top.
  if (!g_open && millis() - g_lastDrain >= 1000) {
    g_lastDrain = millis();
    if (WiFi.status() != WL_CONNECTED) wifiConnect(WIFI_SSID, WIFI_PASSWORD, 100);
    g_ledger.drain(g_spool, 3);
  }
  delay(20);
}
