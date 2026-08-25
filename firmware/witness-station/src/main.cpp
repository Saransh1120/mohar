/**
 * Mohar witness station — ESP32-S3-WROOM-1.
 *
 * One job, scoped as narrowly as the roadmap's privacy argument demands: at the
 * moment the sealed bundle is opened, establish that two *different* enrolled
 * people were physically present, and commit a photograph of that moment to the
 * ledger by hash.
 *
 * What it deliberately does not do:
 *
 *   • It never streams. The camera fires only when a fingerprint match succeeds
 *     — never on a timer, never on motion. Continuous room surveillance is what
 *     `docs/06-hardware-spec.md` ruled out ("no camera anywhere in the design")
 *     and event-scoped capture is the resolution: two consenting officials
 *     performing one duty, not a school corridor.
 *   • It never sends a fingerprint anywhere. The R307 enrols and matches
 *     entirely on its own flash and returns a slot id and a score. The ledger
 *     records "slot 3 matched, score 187"; a database breach cannot leak
 *     biometrics that were never in the database.
 *   • It never sends the image on the critical path. The event carries
 *     SHA-256(jpeg); the JPEG itself goes to the SD card and uploads whenever
 *     bandwidth allows, or never. Losing the image later does not break the
 *     chain — it only means that one commitment can no longer be checked.
 *
 * And the honest limit, which belongs in the source and not only in the pitch:
 * an optical reader is spoofable with a lifted print, and this device is
 * evidence that a body was present, not proof that the right body was.
 */

#include <Adafruit_Fingerprint.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_camera.h>

#include "camera_pins.h"
#include <mohar_crypto.h>
#include <mohar_event.h>
#include <mohar_net.h>
#include <mohar_spool.h>
#include <mohar_time.h>
#include "station_config.h"

using namespace mohar;

// ── state ───────────────────────────────────────────────────────────────────

static Identity g_id;
static Clock g_clock;
static Spool g_spool;
static Ledger g_ledger;

static HardwareSerial g_fpSerial(1);
static Adafruit_Fingerprint g_finger(&g_fpSerial);
static Adafruit_SSD1306 g_oled(128, 64, &Wire, -1);

static bool g_cameraOk = false;
static bool g_fingerOk = false;
static bool g_oledOk = false;

static uint32_t g_sequence = 0;
static uint32_t g_lastHeartbeatMs = 0;

/** The ceremony in progress, if any. */
struct Ceremony {
  bool active = false;
  char sessionId[37] = {0};
  uint16_t firstSlot = 0;
  uint32_t firstAtUnix = 0;
  uint8_t assertions = 0;
};
static Ceremony g_ceremony;

// ── indicators ──────────────────────────────────────────────────────────────

/**
 * A square wave on a passive buzzer rather than `tone()`, which has moved
 * between Arduino-ESP32 major versions. Not worth a build break in a room where
 * the sound is the only feedback an official standing over the reader gets.
 */
static void beep(uint16_t hz, uint16_t ms) {
  const uint32_t halfUs = 500000UL / hz;
  const uint32_t cycles = (static_cast<uint32_t>(ms) * 1000UL) / (halfUs * 2);
  for (uint32_t i = 0; i < cycles; ++i) {
    digitalWrite(PIN_BUZZER, HIGH);
    delayMicroseconds(halfUs);
    digitalWrite(PIN_BUZZER, LOW);
    delayMicroseconds(halfUs);
  }
}

static void beepOk() { beep(1800, 90); }
static void beepDone() { beep(1200, 90); delay(60); beep(2400, 140); }
static void beepRefuse() { beep(400, 300); }

/**
 * The two-person state has to be visible in the room.
 *
 * If the officials cannot see which of them the device thinks has authenticated,
 * the ceremony becomes something they perform at a black box and the whole
 * co-presence claim rests on a log nobody in the room ever saw.
 */
static void show(const char *line1, const char *line2 = "", const char *line3 = "") {
  Serial.printf("[witness] %s | %s | %s\n", line1, line2, line3);
  if (!g_oledOk) return;
  g_oled.clearDisplay();
  g_oled.setTextColor(SSD1306_WHITE);
  g_oled.setTextSize(1);
  g_oled.setCursor(0, 0);
  g_oled.println(line1);
  g_oled.setCursor(0, 20);
  g_oled.println(line2);
  g_oled.setCursor(0, 36);
  g_oled.println(line3);

  g_oled.setCursor(0, 56);
  if (g_spool.pending() == 0) {
    g_oled.print(WiFi.status() == WL_CONNECTED ? "synced" : "offline, buffered 0");
  } else {
    g_oled.printf("%u queued", g_spool.pending());
  }
  g_oled.display();
}

// ── sequence persistence ────────────────────────────────────────────────────

static const char *kSeqPath = "/mohar/sequence.txt";

static void loadSequence() {
  File f = SD_MMC.open(kSeqPath, FILE_READ);
  if (!f) return;
  g_sequence = static_cast<uint32_t>(f.readStringUntil('\n').toInt());
  f.close();
}

static void saveSequence() {
  File f = SD_MMC.open(kSeqPath, FILE_WRITE);
  if (!f) return;
  f.printf("%u\n", g_sequence);
  f.close();
}

// ── emitting ────────────────────────────────────────────────────────────────

static void emit(const char *kind, const String &payloadJson) {
  char iso[25];
  g_clock.nowIso(iso);

  char eventId[37];
  uuid4(eventId);

  String record = signedEvent(g_id, kind, iso, eventId, payloadJson.c_str());
  if (record.length() == 0) {
    Serial.println("[witness] refusing to emit a body that failed canonicalisation");
    return;
  }
  if (!g_spool.append(iso, record)) {
    Serial.println("[witness] SD write failed — record NOT transmitted");
    return;
  }
}

static void emitHeartbeat() {
  g_sequence++;
  saveSequence();
  // Keys ascending: bufferedRecords, monitorId, sequence.
  JsonWriter p;
  p.num("bufferedRecords", g_spool.pending());
  p.str("monitorId", DEVICE_ID);
  p.num("sequence", g_sequence);
  emit("MONITOR_HEARTBEAT", p.done());
}

static void emitException(const char *code, const char *detail) {
  JsonWriter p;
  p.str("code", code);
  p.str("detail", detail);
  emit("EXCEPTION_RAISED", p.done());
}

// ── capture ─────────────────────────────────────────────────────────────────

/**
 * Capture one frame, hash it, write it to the card.
 *
 * `esp_camera_fb_return` is called on every path. A leaked frame buffer costs
 * ~100 KB of PSRAM and the second ceremony of the day is the one that fails.
 */
static bool captureFrame(const char *tag, char outHashHex[65], size_t *outBytes) {
  if (!g_cameraOk) return false;

  // Two grabs: the first frame after the sensor has been idle is usually
  // mis-exposed, and a dark unusable photograph committed to the chain is worse
  // than useless because it looks like evidence.
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();
  if (!fb) return false;

  Sha256Stream h;
  h.update(fb->buf, fb->len);
  h.finishHex(outHashHex);
  *outBytes = fb->len;

  if (!SD_MMC.exists("/frames")) SD_MMC.mkdir("/frames");
  String path = String("/frames/") + tag + ".jpg";
  File f = SD_MMC.open(path, FILE_WRITE);
  if (f) {
    f.write(fb->buf, fb->len);
    f.flush();
    f.close();
  } else {
    // The hash still goes to the ledger. The commitment is what the chain
    // needs; the image is corroboration that can be lost without breaking it.
    Serial.println("[witness] could not store the frame — committing the hash anyway");
  }

  esp_camera_fb_return(fb);
  return true;
}

// ── the ceremony ────────────────────────────────────────────────────────────

static const char *roleForSlot(uint16_t slot) {
  return slot >= OBSERVER_SLOT_MIN ? "observer" : "superintendent";
}

static void emitAssertion(uint16_t slot, uint16_t score, const char *frameHash,
                          size_t frameBytes) {
  g_sequence++;
  saveSequence();

#if USE_WITNESS_EVENT_KINDS
  // Keys ascending: frameBytes, frameSha256, matchScore, role, sequence,
  //                 sessionId, stationId, templateSlot.
  JsonWriter p;
  p.num("frameBytes", static_cast<long long>(frameBytes));
  p.str("frameSha256", frameHash);
  p.num("matchScore", score);
  p.str("role", roleForSlot(slot));
  p.num("sequence", g_sequence);
  p.str("sessionId", g_ceremony.sessionId);
  p.str("stationId", DEVICE_ID);
  p.num("templateSlot", slot);
  emit("WITNESS_ASSERTED", p.done());
#else
  // Compatibility path: an unmodified ledger already accepts ACCESS_REQUESTED
  // with a `photoSha256`, so the frame commitment reaches the chain and shows up
  // in the control room with no server change. The slot and score have nowhere
  // to go in this shape, which is exactly why the new kinds exist.
  (void)slot;
  (void)score;
  (void)frameBytes;
  JsonWriter p;
  p.str("photoSha256", frameHash);
  p.str("sessionId", g_ceremony.sessionId);
  emit("ACCESS_REQUESTED", p.done());
#endif
}

static void emitCeremonyOutcome(const char *outcome, bool distinctSlots) {
  g_sequence++;
  saveSequence();

#if USE_WITNESS_EVENT_KINDS
  // Keys ascending: assertionCount, distinctSlots, outcome, sequence,
  //                 sessionId, stationId, windowSeconds.
  JsonWriter p;
  p.num("assertionCount", g_ceremony.assertions);
  p.boolean("distinctSlots", distinctSlots);
  p.str("outcome", outcome);
  p.num("sequence", g_sequence);
  p.str("sessionId", g_ceremony.sessionId);
  p.str("stationId", DEVICE_ID);
  p.num("windowSeconds", CEREMONY_WINDOW_SECONDS);
  emit("WITNESS_CEREMONY", p.done());
#else
  char detail[220];
  snprintf(detail, sizeof(detail),
           "witness ceremony %s: %u assertion(s) in a %d s window, distinct "
           "templates: %s",
           outcome, g_ceremony.assertions, CEREMONY_WINDOW_SECONDS,
           distinctSlots ? "yes" : "no");
  emitException("witness_ceremony", detail);
#endif
}

static void resetCeremony() {
  g_ceremony = Ceremony();
}

/**
 * One successful match.
 *
 * The order matters and is the whole design: capture, hash, write to the card,
 * and only then let anything touch the radio. The transmit happens later, from
 * the idle loop, because the ESP32-S3 driving the camera and the Wi-Fi stack at
 * the same time is the top-ranked integration risk in the roadmap and it
 * presents as a reboot at the moment of capture.
 */
static void onMatch(uint16_t slot, uint16_t score) {
  if (score < MIN_MATCH_SCORE) {
    // Recorded, not silently discarded. A run of weak matches on the morning of
    // an exam is a fact somebody should be able to see afterwards.
    char detail[200];
    snprintf(detail, sizeof(detail),
             "template slot %u matched at score %u, below the %d threshold; not "
             "counted as an assertion",
             slot, score, MIN_MATCH_SCORE);
    emitException("biometric_low_confidence", detail);
    beepRefuse();
    show("Try again", "Match too weak", "Clean and re-present");
    delay(1200);
    return;
  }

  if (!g_ceremony.active) {
    resetCeremony();
    g_ceremony.active = true;
    uuid4(g_ceremony.sessionId);
    g_ceremony.firstAtUnix = g_clock.unixTime();
  }

  bool duplicateFinger = g_ceremony.assertions > 0 && slot == g_ceremony.firstSlot;

  show("Capturing…", roleForSlot(slot), "Hold still");

  char frameHash[65] = {0};
  size_t frameBytes = 0;
  char tag[64];
  snprintf(tag, sizeof(tag), "%.8s-%u-%u", g_ceremony.sessionId, g_sequence + 1, slot);

  if (!captureFrame(tag, frameHash, &frameBytes)) {
    // No frame means no `witness_capture` evidence. The assertion is still
    // recorded — the biometric fact happened — but the missing frame is stated
    // rather than glossed, because the access engine has to be able to tell
    // "photographed" from "not photographed".
    emitException("witness_capture_failed",
                  "fingerprint matched but no camera frame could be captured; "
                  "this assertion has no visual corroboration");
    strlcpy(frameHash,
            "0000000000000000000000000000000000000000000000000000000000000000",
            sizeof(frameHash));
    frameBytes = 0;
  }

  emitAssertion(slot, score, frameHash, frameBytes);
  g_ceremony.assertions++;
  if (g_ceremony.assertions == 1) g_ceremony.firstSlot = slot;

  char l2[24], l3[24];
  snprintf(l2, sizeof(l2), "slot %u  score %u", slot, score);

  if (g_ceremony.assertions == 1) {
    beepOk();
    snprintf(l3, sizeof(l3), "1 of 2 - %ds left", CEREMONY_WINDOW_SECONDS);
    show(roleForSlot(slot), l2, l3);
    return;
  }

  if (duplicateFinger) {
    // One person tapping twice is not two people. Same principle the ledger
    // enforces when it refuses a co-signature from the signing device itself.
    emitCeremonyOutcome("same_finger_twice", false);
    beepRefuse();
    show("Refused", "Same finger twice", "Two people required");
    delay(2500);
    resetCeremony();
    return;
  }

  emitCeremonyOutcome("two_person_confirmed", true);
  beepDone();
  show("2 of 2 present", l2, "Proceeding");
  delay(2500);
  resetCeremony();
}

static void pollFingerprint() {
  if (!g_fingerOk) return;
  if (g_finger.getImage() != FINGERPRINT_OK) return;
  if (g_finger.image2Tz() != FINGERPRINT_OK) return;
  if (g_finger.fingerFastSearch() != FINGERPRINT_OK) {
    beepRefuse();
    show("Not recognised", "No enrolled match", "");
    delay(1200);
    return;
  }
  onMatch(g_finger.fingerID, g_finger.confidence);
}

static void pollCeremonyWindow() {
  if (!g_ceremony.active) return;
  uint32_t elapsed = g_clock.unixTime() - g_ceremony.firstAtUnix;
  if (elapsed < CEREMONY_WINDOW_SECONDS) return;

  // An expired window is a recorded outcome, not a quiet reset. "One official
  // authenticated and the second never arrived" is a fact worth having.
  emitCeremonyOutcome("window_expired", false);
  beepRefuse();
  show("Window expired", "Second official", "did not authenticate");
  delay(2500);
  resetCeremony();
}

// ── bring-up ────────────────────────────────────────────────────────────────

static bool beginCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // SVGA at quality 12 lands around 60–120 KB, which is the ~100 KB the roadmap
  // budgets. Large enough to identify two faces across a table, small enough
  // that a rural uplink can eventually drain a day of them.
  c.frame_size = FRAMESIZE_SVGA;
  c.jpeg_quality = 12;
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;

  if (!psramFound()) {
    // Refuse rather than degrade. Without PSRAM the frame buffer competes with
    // the Wi-Fi stack and the board reboots during capture — a failure that
    // looks like flaky hardware and is actually a missing build flag.
    Serial.println("[witness] no PSRAM detected — check board_build.arduino.memory_type");
    return false;
  }
  return esp_camera_init(&c) == ESP_OK;
}

static void halt(const char *why, uint32_t blinkMs) {
  Serial.printf("[witness] HALTED: %s\n", why);
  show("HALTED", why, "");
  while (true) {
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    delay(blinkMs);
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  g_oledOk = g_oled.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR);
  show("Mohar witness", "starting…");

  if (!identityFromHex(g_id, DEVICE_ID, EXAM_ID, CENTRE_ID, PACKAGE_ID,
                       DEVICE_PRIVKEY, DEVICE_PUBKEY)) {
    halt("provisioning invalid", 120);
  }

  if (!g_clock.begin()) halt("no DS3231", 500);
  bool clockSuspect = g_clock.lostPower();

  SD_MMC.setPins(SDMMC_CLK_PIN, SDMMC_CMD_PIN, SDMMC_D0_PIN);
  if (!SD_MMC.begin("/sdcard", true)) halt("no microSD", 900);
  g_spool.begin(SD_MMC, "/mohar");
  loadSequence();

  g_fpSerial.begin(57600, SERIAL_8N1, PIN_FP_RX, PIN_FP_TX);
  g_fingerOk = g_finger.verifyPassword();
  if (g_fingerOk) g_finger.getTemplateCount();

  g_cameraOk = beginCamera();

  g_ledger.begin(LEDGER_BASE_URL);
  wifiConnect(WIFI_SSID, WIFI_PASSWORD);

  if (clockSuspect) {
    emitException("rtc_lost_power",
                  "DS3231 reports a power loss; the two-person window on this "
                  "station cannot be trusted until it is re-set");
  }
  if (!g_fingerOk) {
    emitException("sensor_absent_fingerprint",
                  "the fingerprint module did not answer; no biometric "
                  "assertions can be produced by this station");
  }
  if (!g_cameraOk) {
    emitException("sensor_absent_camera",
                  "the camera did not initialise; assertions will be recorded "
                  "without visual corroboration");
  }

  emitHeartbeat();
  g_lastHeartbeatMs = millis();

  char l2[32];
  snprintf(l2, sizeof(l2), "%u templates", g_fingerOk ? g_finger.templateCount : 0);
  show("Ready", l2, "Present finger");
}

void loop() {
  // The button abandons a half-finished ceremony. Someone has to be able to say
  // "we stopped" without waiting out the window, and the abandonment is recorded
  // like everything else.
  if (digitalRead(PIN_BUTTON) == LOW && g_ceremony.active) {
    emitCeremonyOutcome("window_expired", false);
    beepRefuse();
    show("Abandoned", "Ceremony cancelled", "");
    delay(1500);
    resetCeremony();
    show("Ready", "", "Present finger");
  }

  pollFingerprint();
  pollCeremonyWindow();

  if (millis() - g_lastHeartbeatMs >= HEARTBEAT_SECONDS * 1000UL) {
    emitHeartbeat();
    g_lastHeartbeatMs = millis();
  }

  // Transmit only while idle. Capture first, transmit second, never
  // concurrently — the roadmap's top-ranked integration risk.
  if (!g_ceremony.active) {
    if (WiFi.status() != WL_CONNECTED) wifiConnect(WIFI_SSID, WIFI_PASSWORD, 4000);
    if (g_ledger.drain(g_spool, 5) > 0 && g_spool.pending() == 0) {
      show("Ready", "all records synced", "Present finger");
    }
  }

  digitalWrite(PIN_LED, g_spool.pending() == 0 ? HIGH : LOW);
  delay(50);
}
