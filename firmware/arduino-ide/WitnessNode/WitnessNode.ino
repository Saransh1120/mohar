/**
 * Mohar witness node — classic ESP32-WROOM-32 with an R307 fingerprint reader.
 *
 * The witness station split in two. This board owns the biometric half: it
 * establishes that two *different* enrolled people were physically present at
 * the moment the sealed bundle was opened, and signs that fact into the ledger.
 * The photograph is taken by the centre PC's own camera and committed
 * separately, joined to this record by a shared `sessionId`.
 *
 * Why the split is worth naming rather than glossing: on an ESP32-S3 witness
 * station the same device reads the finger and takes the frame, and signs both
 * into one record. Here they are two devices, so a compromised centre PC could
 * pair a genuine assertion with a substituted frame. That is a real weakening.
 * What survives is that both halves are signed by separately enrolled devices
 * and land in an append-only chain, so the substitution has to be committed to
 * at the time and cannot be arranged afterwards.
 *
 * What this device never does, unchanged from the original design:
 *
 *   • It never sends a fingerprint anywhere. The R307 enrols and matches
 *     entirely on its own flash and returns a slot id and a score. The ledger
 *     records "slot 3 matched, score 187"; a database breach cannot leak a
 *     biometric that was never in the database.
 *   • It never asserts what it did not observe. With no camera fitted, every
 *     assertion carries a zero frame hash and zero length, and the device says
 *     so out loud once per boot.
 *
 * And the honest limit, which belongs in the source and not only in the pitch:
 * an optical reader is spoofable with a lifted print. This is evidence that a
 * body was present, not proof that the right body was.
 */

#include <Adafruit_Fingerprint.h>
#include <Arduino.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Wire.h>

#include <mohar_crypto.h>
#include <mohar_event.h>
#include <mohar_net.h>
#include <mohar_spool.h>
#include <mohar_time.h>
#include "node_config.h"

using namespace mohar;

// ── state ───────────────────────────────────────────────────────────────────

static Identity g_id;
static Clock g_clock;
static Spool g_spool;
static Ledger g_ledger;
static Preferences g_nvs;

static HardwareSerial g_fpSerial(1);
static Adafruit_Fingerprint g_finger(&g_fpSerial);
static bool g_fingerOk = false;

static uint32_t g_sequence = 0;
static uint32_t g_lastHeartbeatMs = 0;

/** No camera on this board. Stated in the record, not left to inference. */
static const char *kNoFrame =
    "0000000000000000000000000000000000000000000000000000000000000000";

struct Ceremony {
  bool active = false;
  char sessionId[37] = {0};
  uint16_t firstSlot = 0;
  uint32_t firstAtUnix = 0;
  uint8_t assertions = 0;
};
static Ceremony g_ceremony;

// ── the station's own HTTP surface ──────────────────────────────────────────
//
// So the reader can be driven from the control room instead of from a serial
// console. Enrolment is not a factory step — it happens per centre, per exam
// cycle, and again the morning somebody's hands are too dry to read — and a
// procedure that requires a laptop, a cable and the Arduino IDE is a procedure
// that gets skipped.
//
// Deliberately unauthenticated and deliberately read-mostly. It can enrol and
// delete templates on this reader and nothing else: it cannot sign, cannot
// reach the ledger, and holds no key. Anyone who can reach this port is already
// on the exam-hall LAN and standing next to the device — and the thing that
// matters, the signed record, still comes from the key in flash. Do not expose
// it beyond that LAN; when `gateway` exists this belongs behind it.
static WebServer g_http(80);

/**
 * Whether the control surface is listening yet.
 *
 * It cannot start until there is an address to listen on, and Wi-Fi does not
 * reliably come up inside setup() — a phone hotspot in particular often takes
 * longer than any sensible boot-time timeout. Starting it only if the first
 * connection attempt happened to succeed produced a node that was demonstrably
 * online, signing events, and unreachable from the control room.
 */
static bool g_httpStarted = false;

/**
 * Where the ledger is, settable at runtime.
 *
 * The compiled value in `node_config.h` is only a default. A phone hotspot
 * hands out a different subnet every time it restarts, so an address baked into
 * flash is wrong again within a day — and reflashing a device to tell it a new
 * IP is a poor way to spend the hour before an exam.
 *
 * Held in NVS so it survives a reboot, and reported by `/status` so the control
 * room can show what the device is actually trying to reach rather than what
 * somebody assumed it was.
 */
static String g_ledgerUrl;

/**
 * Enrolment as a state machine rather than a blocking routine.
 *
 * The old version sat in a `while` loop waiting for a finger, which is fine at a
 * serial console and impossible over HTTP: the heartbeat would stop, the ledger
 * queue would stall, and the browser would be left holding a request for twenty
 * seconds. Each step now advances once per loop, so the device stays alive and
 * the page can watch progress.
 */
enum class EnrolState : uint8_t {
  Idle,
  WaitFirst,
  WaitLift,
  WaitSecond,
  Done,
  Failed,
};

static EnrolState g_enrolState = EnrolState::Idle;
static uint16_t g_enrolSlot = 0;
static uint32_t g_enrolStepStartedMs = 0;
static String g_enrolMessage = "idle";

/** How long any one step may wait for the person to do their part. */
static const uint32_t ENROL_STEP_TIMEOUT_MS = 30000;

static const char *enrolStateName(EnrolState st) {
  switch (st) {
    case EnrolState::WaitFirst: return "place_finger";
    case EnrolState::WaitLift: return "lift_finger";
    case EnrolState::WaitSecond: return "place_again";
    case EnrolState::Done: return "stored";
    case EnrolState::Failed: return "failed";
    default: return "idle";
  }
}

// ── indicators ──────────────────────────────────────────────────────────────

static void beep(uint16_t hz, uint16_t ms) {
#if HAVE_BUZZER
  const uint32_t halfUs = 500000UL / hz;
  const uint32_t cycles = (static_cast<uint32_t>(ms) * 1000UL) / (halfUs * 2);
  for (uint32_t i = 0; i < cycles; ++i) {
    digitalWrite(PIN_BUZZER, HIGH);
    delayMicroseconds(halfUs);
    digitalWrite(PIN_BUZZER, LOW);
    delayMicroseconds(halfUs);
  }
#else
  (void)hz;
  (void)ms;
#endif
}

static void beepOk() { beep(1800, 90); }
static void beepDone() { beep(1200, 90); delay(60); beep(2400, 140); }
static void beepRefuse() { beep(400, 300); }

/**
 * Granted and refused must not be told apart by looking at a screen.
 *
 * Two people standing over a reader hear the answer before they read it, so the
 * two patterns are made deliberately unlike each other: a short rising figure
 * for granted, three long low tones for refused. A refusal that sounds like a
 * slightly different success is a refusal people will walk past.
 */
static void beepGranted() {
  beep(1400, 110);
  delay(50);
  beep(1900, 110);
  delay(50);
  beep(2600, 220);
}

static void beepDenied() {
  for (int i = 0; i < 3; ++i) {
    beep(320, 380);
    delay(140);
  }
}

/** Could not ask. Distinct from refused, because it means something else. */
static void beepUnreachable() {
  beep(700, 120);
  delay(90);
  beep(700, 120);
}

/**
 * The two-person state has to be visible in the room.
 *
 * With no OLED fitted yet this is the serial console and the buzzer. If the
 * officials cannot tell which of them the device thinks has authenticated, the
 * ceremony becomes something they perform at a black box, and the co-presence
 * claim rests on a log nobody in the room ever saw.
 */
static void show(const char *line) { Serial.printf("[witness] %s\n", line); }

// ── sequence ────────────────────────────────────────────────────────────────

/**
 * In NVS, not on a card — this board has no storage fitted, and a counter that
 * restarts at 1 turns a power-cycled device into one that looks brand new. The
 * whole value of the counter is that gaps in it are visible.
 */
static void loadSequence() {
  g_nvs.begin("mohar", false);
  g_sequence = g_nvs.getULong("seq", 0);
}

static void loadLedgerUrl() {
  g_ledgerUrl = g_nvs.getString("ledger", LEDGER_BASE_URL);
  if (g_ledgerUrl.length() == 0) g_ledgerUrl = LEDGER_BASE_URL;
}

static void saveLedgerUrl(const String &url) {
  g_ledgerUrl = url;
  g_nvs.putString("ledger", url);
  g_ledger.begin(g_ledgerUrl.c_str());
  Serial.printf("[witness] ledger address set to %s\n", g_ledgerUrl.c_str());
}

static void saveSequence() { g_nvs.putULong("seq", g_sequence); }

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
    Serial.println("[witness] buffer write failed — record NOT transmitted");
    return;
  }
  Serial.printf("[witness] %s seq=%u queued (%u pending)\n", kind, g_sequence,
                g_spool.pending());
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

static const char *roleForSlot(uint16_t slot) {
  return slot >= OBSERVER_SLOT_MIN ? "observer" : "superintendent";
}

static void emitAssertion(uint16_t slot, uint16_t score) {
  g_sequence++;
  saveSequence();

  // Keys ascending: frameBytes, frameSha256, matchScore, role, sequence,
  //                 sessionId, stationId, templateSlot.
  //
  // The frame fields are zero because this board has no camera. They are sent
  // rather than omitted because the contract requires them, and a zero length
  // beside a zero hash is the unambiguous way to say "no frame from here" —
  // the access engine reads it as absent evidence, not as evidence of absence.
  JsonWriter p;
  p.num("frameBytes", 0);
  p.str("frameSha256", kNoFrame);
  p.num("matchScore", score);
  p.str("role", roleForSlot(slot));
  p.num("sequence", g_sequence);
  p.str("sessionId", g_ceremony.sessionId);
  p.str("stationId", DEVICE_ID);
  p.num("templateSlot", slot);
  emit("WITNESS_ASSERTED", p.done());
}

static void emitCeremonyOutcome(const char *outcome, bool distinctSlots) {
  g_sequence++;
  saveSequence();

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
}

// ── the ceremony ────────────────────────────────────────────────────────────

static void resetCeremony() { g_ceremony = Ceremony(); }

#if REQUEST_ACCESS_AFTER_CEREMONY
// Defined below, next to the rest of the decision handling. Declared here
// because `onMatch` calls it: the Arduino IDE would generate this prototype
// itself, but PlatformIO compiles the same file as plain C++ and would not.
static void requestUnlock();
#endif

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
    show("match too weak — clean the platen and re-present");
    return;
  }

  if (!g_ceremony.active) {
    resetCeremony();
    g_ceremony.active = true;
    uuid4(g_ceremony.sessionId);
    g_ceremony.firstAtUnix = g_clock.unixTime();
    Serial.printf("[witness] session %s opened\n", g_ceremony.sessionId);
  }

  bool duplicateFinger = g_ceremony.assertions > 0 && slot == g_ceremony.firstSlot;

  emitAssertion(slot, score);
  g_ceremony.assertions++;
  if (g_ceremony.assertions == 1) g_ceremony.firstSlot = slot;

  char line[96];
  if (g_ceremony.assertions == 1) {
    beepOk();
    snprintf(line, sizeof(line), "%s: slot %u score %u — 1 of 2, %d s left",
             roleForSlot(slot), slot, score, CEREMONY_WINDOW_SECONDS);
    show(line);
    return;
  }

  if (duplicateFinger) {
    // One person tapping twice is not two people — the same principle the
    // ledger enforces when it refuses a co-signature from the signing device.
    emitCeremonyOutcome("same_finger_twice", false);
    beepRefuse();
    show("refused: same finger twice — two people are required");
    resetCeremony();
    return;
  }

  emitCeremonyOutcome("two_person_confirmed", true);
  beepDone();
  snprintf(line, sizeof(line), "2 of 2 present — slot %u score %u — proceeding",
           slot, score);
  show(line);

#if REQUEST_ACCESS_AFTER_CEREMONY
  requestUnlock();
#endif

  resetCeremony();
}

#if REQUEST_ACCESS_AFTER_CEREMONY
/**
 * Ask whether this package may be opened, and say the answer out loud.
 *
 * The two-person rule being satisfied is not permission. It is one of
 * twenty-one checks, and the others — the custody key, the window, the seal,
 * the package state — are evaluated by the engine and can refuse a ceremony
 * that went perfectly. Wiring the buzzer to the ceremony instead of to the
 * decision would tell the room the opposite of the truth.
 */
static void requestUnlock() {
  if (!PACKAGE_ID[0]) {
    show("no package configured — not asking for a decision");
    return;
  }

  show("asking the access engine…");
  AccessDecision d = g_ledger.requestAccess(PACKAGE_ID, ACCESS_STAGE, DEVICE_ID,
                                            g_ceremony.sessionId, CUSTODY_KEY);

  if (!d.reached) {
    // Not a refusal. The officials need to know the difference between "the
    // system said no" and "the system could not be asked".
    char line[96];
    snprintf(line, sizeof(line), "could not reach the access engine (http %d)",
             d.httpStatus);
    show(line);
    beepUnreachable();
    emitException("access_engine_unreachable",
                  "the two-person window closed but no unlock decision could be "
                  "obtained; this is not a refusal and must not be treated as one");
    return;
  }

  if (d.granted) {
    show("ACCESS GRANTED");
    beepGranted();
    return;
  }

  char line[220];
  snprintf(line, sizeof(line), "ACCESS REFUSED — %s", d.denyReasons.c_str());
  show(line);
  beepDenied();
}
#endif

// ── enrolment ───────────────────────────────────────────────────────────────

/**
 * Enrol a finger without swapping firmware.
 *
 * Kept on the operating device on purpose. Enrolment is not a factory step: it
 * happens per centre, per exam cycle, and it happens again the morning someone's
 * hands are too dry to read. Making it require a different sketch guarantees it
 * gets skipped.
 *
 * Nothing enrolled here reaches the ledger. The template lives and dies on the
 * reader's own flash; what the chain later records is a slot number, and the
 * mapping from slot to person is registered separately through
 * `POST /fingerprints` from the control room.
 */
static long readSlotFromSerial() {
  Serial.println();
  Serial.printf("Slot to enrol into (1..127). Below %d is the superintendent, "
                "%d and above is the observer.\n",
                OBSERVER_SLOT_MIN, OBSERVER_SLOT_MIN);
  Serial.print("slot> ");
  while (true) {
    while (!Serial.available()) delay(40);
    long v = Serial.parseInt();
    while (Serial.available()) Serial.read();
    if (v >= 1 && v <= 127) return v;
    Serial.print("out of range, try again> ");
  }
}

static void enrolFail(const char *why) {
  g_enrolState = EnrolState::Failed;
  g_enrolMessage = why;
  Serial.printf("[enrol] failed: %s\n", why);
}

/** Begin an enrolment. Returns false if one is already running. */
static bool startEnrol(uint16_t slot) {
  if (!g_fingerOk) {
    enrolFail("no fingerprint module on this station");
    return false;
  }
  if (g_enrolState == EnrolState::WaitFirst || g_enrolState == EnrolState::WaitLift ||
      g_enrolState == EnrolState::WaitSecond) {
    return false;
  }
  g_enrolSlot = slot;
  g_enrolState = EnrolState::WaitFirst;
  g_enrolStepStartedMs = millis();
  g_enrolMessage = "place the finger on the reader and hold it";
  Serial.printf("[enrol] slot %u — %s\n", slot, g_enrolMessage.c_str());
  return true;
}

/**
 * One impression, taken the moment the finger has settled.
 *
 * The frame captured the instant contact is made is smeared and `image2Tz`
 * rejects it, so contact is detected first and the frame that counts is taken
 * a moment later.
 */
static bool takeImpression(uint8_t buffer) {
  if (g_finger.getImage() != FINGERPRINT_OK) return false;
  delay(350);
  if (g_finger.getImage() != FINGERPRINT_OK) return false;
  return g_finger.image2Tz(buffer) == FINGERPRINT_OK;
}

static void enrolStep() {
  if (g_enrolState == EnrolState::Idle || g_enrolState == EnrolState::Done ||
      g_enrolState == EnrolState::Failed) {
    return;
  }

  if (millis() - g_enrolStepStartedMs > ENROL_STEP_TIMEOUT_MS) {
    enrolFail("timed out waiting for the finger");
    return;
  }

  switch (g_enrolState) {
    case EnrolState::WaitFirst:
      if (takeImpression(1)) {
        g_enrolState = EnrolState::WaitLift;
        g_enrolStepStartedMs = millis();
        g_enrolMessage = "lift the finger";
        Serial.printf("[enrol] %s\n", g_enrolMessage.c_str());
      }
      break;

    case EnrolState::WaitLift:
      if (g_finger.getImage() == FINGERPRINT_NOFINGER) {
        delay(400);
        g_enrolState = EnrolState::WaitSecond;
        g_enrolStepStartedMs = millis();
        g_enrolMessage = "place the same finger again, the same way";
        Serial.printf("[enrol] %s\n", g_enrolMessage.c_str());
      }
      break;

    case EnrolState::WaitSecond: {
      if (!takeImpression(2)) break;

      if (g_finger.createModel() != FINGERPRINT_OK) {
        // Almost always the finger landing at a different angle the second
        // time, not a broken reader.
        enrolFail("the two impressions did not match each other — same angle both times");
        break;
      }
      if (g_finger.storeModel(g_enrolSlot) != FINGERPRINT_OK) {
        enrolFail("the reader refused to store the template");
        break;
      }
      g_finger.getTemplateCount();
      g_enrolState = EnrolState::Done;
      g_enrolMessage = "stored — now register who this slot is, in the control room";
      Serial.printf("[enrol] slot %u stored, %u template(s) on this reader\n",
                    g_enrolSlot, g_finger.templateCount);
      break;
    }

    default:
      break;
  }
}

static bool deleteSlot(uint16_t slot) {
  if (!g_fingerOk) return false;
  bool ok = g_finger.deleteModel(slot) == FINGERPRINT_OK;
  g_finger.getTemplateCount();
  Serial.printf("[enrol] delete slot %u: %s (%u remaining)\n", slot,
                ok ? "ok" : "failed", g_finger.templateCount);
  return ok;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * The control room is served from a different origin, so every response needs
 * the grant explicitly. Wide open on purpose: this endpoint holds no secret and
 * can do nothing but manage templates on the reader in front of you.
 */
static void cors() {
  g_http.sendHeader("Access-Control-Allow-Origin", "*");
  g_http.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  g_http.sendHeader("Access-Control-Allow-Headers", "content-type");
  // Refuse keep-alive. This server handles one connection at a time, and a
  // browser polling every few seconds will hold that slot open between polls —
  // after which the endpoint stops answering while the device carries on
  // heartbeating, which looks like a network fault and is not one.
  g_http.sendHeader("Connection", "close");
}

static void sendJson(int code, const String &json) {
  cors();
  g_http.send(code, "application/json", json);
}

static void handleStatus() {
  String j = "{";
  j += "\"deviceId\":\"" DEVICE_ID "\",";
  j += "\"reader\":" + String(g_fingerOk ? "true" : "false") + ",";
  j += "\"templates\":" + String(g_fingerOk ? g_finger.templateCount : 0) + ",";
  j += "\"capacity\":" + String(g_fingerOk ? g_finger.capacity : 0) + ",";
  j += "\"enrol\":{";
  j += "\"state\":\"" + String(enrolStateName(g_enrolState)) + "\",";
  j += "\"slot\":" + String(g_enrolSlot) + ",";
  j += "\"message\":\"" + g_enrolMessage + "\"},";
  j += "\"ceremony\":{";
  j += "\"active\":" + String(g_ceremony.active ? "true" : "false") + ",";
  j += "\"assertions\":" + String(g_ceremony.assertions) + ",";
  j += "\"windowSeconds\":" + String(CEREMONY_WINDOW_SECONDS) + "},";
  // The package this station is configured to witness. The control room reads
  // it so the operator does not have to pick the right one off a list of
  // fifteen under stage lights — a wrong pick there produces a refusal that
  // looks like the system failing when it is the operator who missed.
  j += "\"ledgerUrl\":\"" + g_ledgerUrl + "\",";
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"packageId\":\"" PACKAGE_ID "\",";
  j += "\"centreId\":\"" CENTRE_ID "\",";
  j += "\"pending\":" + String(g_spool.pending()) + ",";
  j += "\"observerSlotMin\":" + String(OBSERVER_SLOT_MIN);
  j += "}";
  sendJson(200, j);
}

static void handleEnrol() {
  long slot = g_http.hasArg("slot") ? g_http.arg("slot").toInt() : 0;
  if (slot < 1 || slot > 127) {
    sendJson(400, "{\"error\":\"slot must be between 1 and 127\"}");
    return;
  }
  if (!startEnrol(static_cast<uint16_t>(slot))) {
    sendJson(409, "{\"error\":\"an enrolment is already running on this reader\"}");
    return;
  }
  sendJson(202, "{\"status\":\"started\",\"slot\":" + String(slot) + "}");
}

/**
 * Point this station at a different ledger.
 *
 * Deliberately does not validate that anything answers there. A ledger that is
 * temporarily down is a normal condition — records buffer and drain later — and
 * refusing to accept the address because nothing replied right now would make
 * the device unconfigurable exactly when it most needs configuring.
 */
static void handleConfig() {
  if (!g_http.hasArg("ledger")) {
    sendJson(400, "{\"error\":\"pass ledger=http://host:port\"}");
    return;
  }
  String url = g_http.arg("ledger");
  url.trim();
  while (url.endsWith("/")) url.remove(url.length() - 1);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    sendJson(400, "{\"error\":\"the address must start with http:// or https://\"}");
    return;
  }
  saveLedgerUrl(url);
  sendJson(200, "{\"status\":\"set\",\"ledgerUrl\":\"" + g_ledgerUrl + "\"}");
}

static void handleCancel() {
  g_enrolState = EnrolState::Idle;
  g_enrolMessage = "cancelled";
  sendJson(200, "{\"status\":\"cancelled\"}");
}

static void handleDelete() {
  long slot = g_http.hasArg("slot") ? g_http.arg("slot").toInt() : 0;
  if (slot < 1 || slot > 127) {
    sendJson(400, "{\"error\":\"slot must be between 1 and 127\"}");
    return;
  }
  bool ok = deleteSlot(static_cast<uint16_t>(slot));
  sendJson(ok ? 200 : 404,
           ok ? "{\"status\":\"deleted\"}" : "{\"error\":\"no template in that slot\"}");
}

/**
 * Bring the control surface up the moment there is an address for it.
 *
 * Called from setup and again from the loop, because Wi-Fi association is not
 * something a boot-time timeout can be relied on to cover. Idempotent: once
 * listening it does nothing, so the loop can call it every pass.
 */
static void startControlSurfaceIfReady();

static void beginHttp() {
  g_http.on("/status", HTTP_GET, handleStatus);
  g_http.on("/enrol", HTTP_POST, handleEnrol);
  g_http.on("/enrol/cancel", HTTP_POST, handleCancel);
  g_http.on("/config", HTTP_POST, handleConfig);
  g_http.on("/slot", HTTP_DELETE, handleDelete);
  g_http.on("/slot/delete", HTTP_POST, handleDelete);
  g_http.onNotFound([]() {
    if (g_http.method() == HTTP_OPTIONS) {
      cors();
      g_http.send(204);
      return;
    }
    sendJson(404, "{\"error\":\"no such endpoint\"}");
  });
  g_http.begin();
}

static void startControlSurfaceIfReady() {
  if (g_httpStarted) return;
  if (WiFi.status() != WL_CONNECTED) return;

  beginHttp();
  g_httpStarted = true;

  // Announced in the chain, not only on a console nobody is watching. The
  // control room needs somewhere to send enrolment commands, and this is the
  // record of where this station was reachable and from when.
  char detail[220];
  snprintf(detail, sizeof(detail),
           "station control endpoint listening at http://%s/ on the exam-hall LAN; "
           "it manages templates on this reader only and holds no key",
           WiFi.localIP().toString().c_str());
  emitException("station_online", detail);
  Serial.printf("[witness] control endpoint: http://%s/\n",
                WiFi.localIP().toString().c_str());
}

static void pollSerialCommand() {
  if (!Serial.available()) return;
  char c = Serial.read();
  while (Serial.available()) Serial.read();
  switch (c) {
    // The console drives the same state machine the HTTP endpoints do. Two
    // routes into one implementation, so the serial monitor and the control
    // room can never disagree about what the reader is doing.
    case 'e': case 'E': startEnrol(static_cast<uint16_t>(readSlotFromSerial())); break;
    case 'd': case 'D': deleteSlot(static_cast<uint16_t>(readSlotFromSerial())); break;
    case 'c': case 'C':
      g_finger.getTemplateCount();
      Serial.printf("%u template(s) stored on this reader.\n", g_finger.templateCount);
      break;
    case '?': case 'h': case 'H':
      Serial.println("e = enrol   d = delete   c = count");
      Serial.println("or drive it from the control room's Ceremony page");
      break;
    default: break;
  }
}

/**
 * True while a finger is still on the platen after a decision was made.
 *
 * The reader reports the same finger continuously, so something has to wait for
 * it to leave before the next read counts. That wait used to be a `while` loop,
 * which stopped everything: no heartbeat, no HTTP, no ledger drain, for as long
 * as somebody rested a thumb on the sensor. Now it is a state the loop passes
 * through.
 */
static bool g_awaitingLift = false;

/**
 * A short deaf period after an accepted assertion.
 *
 * The reader happily reads the same thumb twice if it shifts and settles again,
 * and the second read lands as a second assertion — which the ceremony then
 * correctly calls `same_finger_twice` and refuses. The rule is right; the input
 * was wrong.
 *
 * Two seconds costs nothing real: a genuine second official cannot walk up,
 * place a finger and have it read inside that window, so nothing legitimate is
 * ever suppressed. What it removes is one person's single press being counted
 * as two.
 */
static const uint32_t MATCH_COOLDOWN_MS = 2000;
static uint32_t g_lastMatchMs = 0;

static void pollFingerprint() {
  if (!g_fingerOk) return;

  if (g_awaitingLift) {
    if (g_finger.getImage() == FINGERPRINT_NOFINGER) g_awaitingLift = false;
    return;
  }
  // An enrolment owns the reader while it runs. Matching at the same time would
  // consume the very impression the enrolment is waiting for.
  if (g_enrolState != EnrolState::Idle && g_enrolState != EnrolState::Done &&
      g_enrolState != EnrolState::Failed) {
    return;
  }
  if (g_finger.getImage() != FINGERPRINT_OK) return;

  // The frame taken the instant contact is made is usually smeared. Settle,
  // then take the one we judge.
  delay(250);
  if (g_finger.getImage() != FINGERPRINT_OK) return;
  if (g_finger.image2Tz() != FINGERPRINT_OK) return;

  g_awaitingLift = true;

  if (g_lastMatchMs && millis() - g_lastMatchMs < MATCH_COOLDOWN_MS) {
    Serial.println("[witness] ignoring a repeat read inside the cooldown");
    return;
  }

  if (g_finger.fingerFastSearch() != FINGERPRINT_OK) {
    beepRefuse();
    show("finger seen — no enrolled match");
    // Recorded, not merely printed. A finger presented at the witness station
    // that matches nothing enrolled is a fact worth having: on the morning of an
    // exam it is either a worn hand that needs re-enrolling or somebody who
    // should not be at the reader, and neither is visible if it only ever
    // reached a serial console nobody was watching.
    emitException("biometric_no_match",
                  "a finger was presented at the witness station and matched no "
                  "enrolled template");
  } else {
    g_lastMatchMs = millis();
    onMatch(g_finger.fingerID, g_finger.confidence);
  }
}

static void pollCeremonyWindow() {
  if (!g_ceremony.active) return;
  if (g_clock.unixTime() - g_ceremony.firstAtUnix < CEREMONY_WINDOW_SECONDS) return;

  // An expired window is a recorded outcome, not a quiet reset. "One official
  // authenticated and the second never arrived" is a fact worth having.
  emitCeremonyOutcome("window_expired", false);
  beepRefuse();
  show("window expired — the second official did not authenticate");
  resetCeremony();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

static void halt(const char *why, uint32_t blinkMs) {
  Serial.printf("[witness] HALTED: %s\n", why);
  while (true) {
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    delay(blinkMs);
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  pinMode(PIN_LED, OUTPUT);
#if HAVE_BUZZER
  pinMode(PIN_BUZZER, OUTPUT);
#endif

  Serial.println();
  Serial.println("Mohar witness node");

  // Halt rather than run. A node whose signatures cannot verify looks alive on
  // the bench and is invisible in the ledger, which is the worst of both.
  if (!identityFromHex(g_id, DEVICE_ID, EXAM_ID, CENTRE_ID, PACKAGE_ID,
                       DEVICE_PRIVKEY, DEVICE_PUBKEY)) {
    halt("provisioning is invalid — run tools/provision-device", 120);
  }

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (!g_clock.begin()) halt("no DS3231 on I2C", 500);
  bool clockSuspect = g_clock.lostPower();

  // No card fitted, so the spool is a RAM ring. This is a downgrade from the
  // write-before-transmit rule and the device reports it below rather than
  // quietly losing the guarantee.
  g_spool.beginRam(RAM_SPOOL_RECORDS);
  loadSequence();

  g_fpSerial.begin(57600, SERIAL_8N1, PIN_FP_RX, PIN_FP_TX);
  g_fingerOk = g_finger.verifyPassword();
  if (g_fingerOk) g_finger.getTemplateCount();

  loadLedgerUrl();
  g_ledger.begin(g_ledgerUrl.c_str());
  Serial.printf("[witness] ledger address: %s\n", g_ledgerUrl.c_str());
  bool online = wifiConnect(WIFI_SSID, WIFI_PASSWORD);

  emitException("camera_not_on_this_device",
                "this node has no camera; every assertion it signs carries a zero "
                "frame hash, and the witness frame is captured and committed "
                "separately by the centre client under the same sessionId");
  emitException("spool_absent",
                "no storage fitted; records are buffered in RAM only and will not "
                "survive a power cut or a long network outage");
  if (clockSuspect) {
    emitException("rtc_lost_power",
                  "DS3231 reports a power loss; the two-person window on this node "
                  "cannot be trusted until it is re-set");
  }
  if (!g_fingerOk) {
    emitException("sensor_absent_fingerprint",
                  "the fingerprint module did not answer; no biometric assertions "
                  "can be produced by this node");
  }

  (void)online;
  startControlSurfaceIfReady();

  emitHeartbeat();
  g_lastHeartbeatMs = millis();

  Serial.printf("[witness] wifi %s, reader %s, %u template(s)\n",
                online ? "connected" : "OFFLINE (buffering)",
                g_fingerOk ? "ready" : "ABSENT",
                g_fingerOk ? g_finger.templateCount : 0);
  // Two short notes at boot, so the buzzer is known to work before it is ever
  // asked to say something that matters. A refusal nobody can hear is a refusal
  // that did not happen, and the first time you find out the buzzer is dead
  // should not be the moment it is refusing an unlock.
  beep(1600, 70);
  delay(60);
  beep(2100, 70);

  show("ready — present a finger");
  Serial.println("[witness] serial commands:  e = enrol   d = delete   c = count");
  Serial.println("[witness] buzzer: two notes at boot, one long low tone on refusal,");
  Serial.println("[witness]         three rising notes on granted, three long on denied");
}

void loop() {
  startControlSurfaceIfReady();
  if (g_httpStarted) g_http.handleClient();
  enrolStep();
  pollSerialCommand();
  pollFingerprint();
  pollCeremonyWindow();

  if (millis() - g_lastHeartbeatMs >= HEARTBEAT_SECONDS * 1000UL) {
    emitHeartbeat();
    g_lastHeartbeatMs = millis();
  }

  if (WiFi.status() != WL_CONNECTED) wifiConnect(WIFI_SSID, WIFI_PASSWORD, 4000);
  g_ledger.drain(g_spool, 5);

  digitalWrite(PIN_LED, g_spool.pending() == 0 ? HIGH : LOW);
  delay(50);
}
