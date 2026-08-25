/**
 * Mohar room monitor — ESP32-WROOM-32.
 *
 * Emits two event kinds that already exist in `packages/contracts`, so this
 * firmware integrates with the ledger as it stands today, with no server change:
 *
 *   MONITOR_HEARTBEAT — every 30 s. The absence of these is the signal; a
 *                       server-side watchdog turns a gap into MONITOR_SILENT,
 *                       which the control room shows as requiring a decision.
 *   ROOM_ENTRY        — door state, mmWave presence, light, and footfall counts
 *                       reported as floors rather than exact numbers.
 *
 * Order of operations in every path: build the signed record, put it on the SD
 * card, and only then think about the radio.
 */

#include <Adafruit_VL53L0X.h>
#include <Arduino.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <Wire.h>
#include <ld2410.h>

#include "monitor_config.h"
#include <mohar_crypto.h>
#include <mohar_event.h>
#include <mohar_net.h>
#include <mohar_spool.h>
#include <mohar_time.h>

using namespace mohar;

// ── state ───────────────────────────────────────────────────────────────────

static Identity g_id;
static Clock g_clock;
static Spool g_spool;
static Ledger g_ledger;

static Adafruit_VL53L0X g_tofOuter;  // corridor side
static Adafruit_VL53L0X g_tofInner;  // room side
static ld2410 g_radar;
static HardwareSerial g_radarSerial(2);

static bool g_tofPresent = false;
static bool g_radarPresent = false;
static bool g_haveSd = false;
static Preferences g_nvs;

/**
 * Monotonic sequence number, persisted across reboots.
 *
 * The point is not ordering — the ledger has `seq` for that. It is that a gap
 * in this counter is visible: if the ledger holds sequences 1..40 and then 44,
 * three records existed and did not arrive, which is a different fact from
 * three records never having been made.
 */
static uint32_t g_sequence = 0;

static bool g_doorOpen = false;
static bool g_presence = false;
static bool g_lightOn = false;
static uint32_t g_enteredSinceReport = 0;
static uint32_t g_exitedSinceReport = 0;

static uint32_t g_lastHeartbeatMs = 0;
static uint32_t g_lastConditionReportMs = 0;

// ── sequence persistence ────────────────────────────────────────────────────

/**
 * The sequence lives in NVS, not on the card.
 *
 * It has to survive a reboot even when there is no card at all, because a
 * counter that restarts at 1 turns a device that was power-cycled into a device
 * that looks brand new — and the whole value of the counter is that gaps in it
 * are visible.
 */
static void loadSequence() {
  g_nvs.begin("mohar", false);
  g_sequence = g_nvs.getULong("seq", 0);
}

static void saveSequence() { g_nvs.putULong("seq", g_sequence); }

// ── emitting ────────────────────────────────────────────────────────────────

/**
 * Sign, persist, then transmit — never the other way round.
 *
 * A record that reached the ledger but not the card would be a record the
 * device cannot corroborate afterwards, and a record transmitted before it was
 * durable is one a power cut can turn into a phantom.
 */
static void emit(const char *kind, const String &payloadJson) {
  char iso[25];
  g_clock.nowIso(iso);

  char eventId[37];
  uuid4(eventId);

  String record = signedEvent(g_id, kind, iso, eventId, payloadJson.c_str());
  if (record.length() == 0) {
    Serial.println("[monitor] refusing to emit a body that failed canonicalisation");
    return;
  }

  if (!g_spool.append(iso, record)) {
    Serial.println("[monitor] SD write failed — record NOT transmitted");
    return;
  }
  Serial.printf("[monitor] %s seq=%u queued (%u pending)\n", kind, g_sequence,
                g_spool.pending());
}

static void emitHeartbeat() {
  g_sequence++;
  saveSequence();

  // Keys ascending: bufferedRecords, monitorId, sequence.
  // `batteryMv` is omitted rather than sent as 0 — this board is mains-powered,
  // and an omitted optional field is the only correct way to say "not measured".
  JsonWriter p;
  p.num("bufferedRecords", g_spool.pending());
  p.str("monitorId", DEVICE_ID);
  p.num("sequence", g_sequence);
  emit("MONITOR_HEARTBEAT", p.done());
}

static void emitRoomEntry() {
  g_sequence++;
  saveSequence();

  // Keys ascending: doorOpen, enteredAtLeast, exitedAtLeast, lightOn,
  //                 monitorId, presence, sequence.
  JsonWriter p;
  p.boolean("doorOpen", g_doorOpen);
  p.num("enteredAtLeast", g_enteredSinceReport);
  p.num("exitedAtLeast", g_exitedSinceReport);
  p.boolean("lightOn", g_lightOn);
  p.str("monitorId", DEVICE_ID);
  p.boolean("presence", g_presence);
  p.num("sequence", g_sequence);
  emit("ROOM_ENTRY", p.done());

  // Counts are per-report deltas, not lifetime totals. Summing the events over a
  // window gives the window's traffic, and no single event has to be trusted to
  // carry the whole history.
  g_enteredSinceReport = 0;
  g_exitedSinceReport = 0;
}

static void emitException(const char *code, const char *detail) {
  // Keys ascending: code, detail.
  JsonWriter p;
  p.str("code", code);
  p.str("detail", detail);
  emit("EXCEPTION_RAISED", p.done());
}

// ── footfall ────────────────────────────────────────────────────────────────

/**
 * Direction from beam-break order across two sensors ~15 cm apart.
 *
 * Outer-then-inner is an entry, inner-then-outer an exit. The caveat from
 * docs/06 Part B holds and is not papered over here: two people abreast through
 * a wide door register as one, which is why the payload field is called
 * `enteredAtLeast` and the control room renders it as "at least N".
 */
static void pollFootfall() {
  if (!g_tofPresent) return;

  static bool outerBroken = false, innerBroken = false;
  static uint32_t outerAt = 0, innerAt = 0;

  VL53L0X_RangingMeasurementData_t m;

  g_tofOuter.rangingTest(&m, false);
  bool outerNow = (m.RangeStatus != 4) && (m.RangeMilliMeter < TOF_BREAK_MM);
  if (outerNow && !outerBroken) outerAt = millis();
  outerBroken = outerNow;

  g_tofInner.rangingTest(&m, false);
  bool innerNow = (m.RangeStatus != 4) && (m.RangeMilliMeter < TOF_BREAK_MM);
  if (innerNow && !innerBroken) innerAt = millis();
  innerBroken = innerNow;

  if (outerAt && innerAt) {
    uint32_t gap = outerAt > innerAt ? outerAt - innerAt : innerAt - outerAt;
    if (gap <= TOF_PAIR_WINDOW_MS) {
      if (outerAt < innerAt) {
        g_enteredSinceReport++;
      } else {
        g_exitedSinceReport++;
      }
    }
    outerAt = innerAt = 0;
  }
}

// ── sensors ─────────────────────────────────────────────────────────────────

/**
 * Both VL53L0X sensors ship with the same I2C address, so they are brought up
 * one at a time: hold both in reset, release the outer one and move it to a
 * second address, then release the inner one on the factory address.
 */
static bool beginToF() {
  pinMode(PIN_TOF_OUTER_XSHUT, OUTPUT);
  pinMode(PIN_TOF_INNER_XSHUT, OUTPUT);
  digitalWrite(PIN_TOF_OUTER_XSHUT, LOW);
  digitalWrite(PIN_TOF_INNER_XSHUT, LOW);
  delay(20);

  digitalWrite(PIN_TOF_OUTER_XSHUT, HIGH);
  delay(20);
  if (!g_tofOuter.begin(0x30)) return false;

  digitalWrite(PIN_TOF_INNER_XSHUT, HIGH);
  delay(20);
  if (!g_tofInner.begin(0x29)) return false;

  return true;
}

static void pollSensors() {
#if HAVE_REED
  g_doorOpen = digitalRead(PIN_REED) == HIGH;  // magnet away = contact open
#endif
#if HAVE_LDR
  g_lightOn = analogRead(PIN_LDR) >= LDR_DARK_BELOW;
#endif

  if (g_radarPresent) {
    g_radar.read();
    if (g_radar.isConnected()) g_presence = g_radar.presenceDetected();
  }

  pollFootfall();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

static void halt(const char *why, uint32_t blinkMs) {
  Serial.printf("[monitor] HALTED: %s\n", why);
  while (true) {
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    delay(blinkMs);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_REED, INPUT_PULLUP);
  analogReadResolution(12);

  // Halt rather than run. A monitor whose signatures cannot verify looks alive
  // on the bench and is invisible in the ledger, which is the worst of both.
  if (!identityFromHex(g_id, DEVICE_ID, EXAM_ID, CENTRE_ID, "", DEVICE_PRIVKEY,
                       DEVICE_PUBKEY)) {
    halt("provisioning is invalid", 120);
  }

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  if (!g_clock.begin()) halt("no DS3231 on I2C", 500);
  bool clockSuspect = g_clock.lostPower();

  g_haveSd = SD.begin(PIN_SD_CS);
#if ALLOW_NO_SD
  if (g_haveSd) {
    g_spool.begin(SD, "/mohar");
  } else {
    g_spool.beginRam(RAM_SPOOL_RECORDS);
  }
#else
  if (!g_haveSd) halt("no microSD", 900);
  g_spool.begin(SD, "/mohar");
#endif
  loadSequence();

#if HAVE_LD2410
  g_radarSerial.begin(256000, SERIAL_8N1, PIN_LD2410_RX, PIN_LD2410_TX);
  g_radarPresent = g_radar.begin(g_radarSerial);
#endif
#if HAVE_TOF
  g_tofPresent = beginToF();
#endif

  g_ledger.begin(LEDGER_BASE_URL);
  wifiConnect(WIFI_SSID, WIFI_PASSWORD);

  // Every degraded condition is recorded rather than merely logged to serial. A
  // monitor running with one sensor dead must be visibly different in the ledger
  // from a monitor running with all of them, or the absence of ROOM_ENTRY events
  // reads as an empty room instead of a broken sensor.
  if (!g_haveSd) {
    // Said out loud, every boot. A monitor running without durable storage is a
    // materially weaker witness than one with a card, and the control room has
    // to be able to tell the two apart.
    emitException("spool_absent",
                  "no microSD fitted; records are buffered in RAM only and will "
                  "not survive a power cut or a long network outage");
  }
  if (clockSuspect) {
    emitException("rtc_lost_power",
                  "DS3231 reports a power loss; timestamps from this device are "
                  "suspect until it is re-set");
  }
#if !HAVE_REED
  emitException("sensor_not_fitted_reed",
                "no door sensor is fitted; the doorOpen field in this device's "
                "ROOM_ENTRY records carries no information");
#endif
#if !HAVE_LDR
  emitException("sensor_not_fitted_ldr",
                "no light sensor is fitted; the lightOn field in this device's "
                "ROOM_ENTRY records carries no information");
#endif
  if (HAVE_LD2410 && !g_radarPresent) {
    emitException("sensor_absent_ld2410",
                  "mmWave presence sensor did not answer; presence is reported "
                  "false and must not be read as an empty room");
  }
  if (HAVE_TOF && !g_tofPresent) {
    emitException("sensor_absent_vl53l0x",
                  "one or both ToF sensors did not answer; footfall counts are "
                  "not being produced");
  }

  emitHeartbeat();
  emitRoomEntry();
  g_lastHeartbeatMs = millis();
  g_lastConditionReportMs = millis();
  Serial.println("[monitor] running");
}

void loop() {
  bool doorWas = g_doorOpen;
  bool presenceWas = g_presence;
  bool lightWas = g_lightOn;
  uint32_t footfallWas = g_enteredSinceReport + g_exitedSinceReport;

  pollSensors();

  bool changed = (g_doorOpen != doorWas) || (g_presence != presenceWas) ||
                 (g_lightOn != lightWas) ||
                 (g_enteredSinceReport + g_exitedSinceReport != footfallWas);

  // Report on change, and at least once a minute regardless. The periodic report
  // is what distinguishes "nothing happened" from "the sensor stopped noticing".
  if (changed || millis() - g_lastConditionReportMs >= 60000) {
    emitRoomEntry();
    g_lastConditionReportMs = millis();
  }

  if (millis() - g_lastHeartbeatMs >= HEARTBEAT_SECONDS * 1000UL) {
    emitHeartbeat();
    g_lastHeartbeatMs = millis();
  }

  if (WiFi.status() != WL_CONNECTED) {
    wifiConnect(WIFI_SSID, WIFI_PASSWORD, 4000);
  }
  g_ledger.drain(g_spool, 10);

  digitalWrite(PIN_LED, g_spool.pending() == 0 ? HIGH : LOW);
  delay(60);
}
