/**
 * R307 / AS608 bench check — works on any ESP32.
 *
 * The fingerprint reader is a plain UART device. It has no dependency on the
 * ESP32-S3 whatsoever; only the OV2640 camera does, because that needs the S3's
 * dedicated camera peripheral and PSRAM. So this runs on a classic
 * ESP32-WROOM-32 exactly as well as on an S3.
 *
 * This sketch proves the module and nothing else — it signs no records and
 * never talks to the ledger. Get a slot and a score printing here before
 * wiring the reader into anything larger.
 *
 * Needs one library: "Adafruit Fingerprint Sensor Library" from Library Manager.
 *
 * Serial commands, 115200 baud:
 *   e   enrol a finger into a slot
 *   d   delete one slot
 *   c   count stored templates
 *   (otherwise it just watches for a finger and reports matches)
 */

#include <Adafruit_Fingerprint.h>
#include <Arduino.h>

// ── pins ────────────────────────────────────────────────────────────────────
//
// Named from the ESP32's point of view: FP_RX is the pin the ESP32 *receives*
// on, so it goes to the module's TXD. Getting this backwards gives you a module
// that powers up, lights its ring, and never answers — the single most common
// failure with these readers.
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #define FP_RX 14   // ESP32-S3 RX  <- module TXD
  #define FP_TX 21   // ESP32-S3 TX  -> module RXD
#else
  // Classic ESP32-WROOM-32. Chosen to avoid every pin the room monitor uses,
  // so the reader can stay wired while you build the rest.
  #define FP_RX 32   // ESP32 RX  <- module TXD
  #define FP_TX 33   // ESP32 TX  -> module RXD
#endif

// The module's factory default. Do not change it unless you have deliberately
// reconfigured the reader.
#define FP_BAUD 57600

static HardwareSerial fpSerial(1);
static Adafruit_Fingerprint finger(&fpSerial);

// ── helpers ─────────────────────────────────────────────────────────────────

static long readNumber(const char *prompt, long lo, long hi) {
  Serial.print(prompt);
  while (true) {
    while (!Serial.available()) delay(40);
    long v = Serial.parseInt();
    while (Serial.available()) Serial.read();  // drain the newline
    if (v >= lo && v <= hi) return v;
    Serial.printf("Out of range (%ld..%ld). Try again: ", lo, hi);
  }
}

static void waitForLift() {
  Serial.println("  lift the finger");
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(60);
  // The sensor keeps reporting the last frame briefly after the finger leaves.
  // Without this the next capture can start on a stale, half-lifted image.
  delay(400);
}

/**
 * Take one usable impression.
 *
 * The first frame after a finger lands is nearly always unusable — the finger is
 * still settling and the ridges are smeared, so `image2Tz` rejects it. Waiting
 * for contact and then grabbing a *second* frame a moment later is what makes
 * enrolment work with a dry or hurried finger.
 *
 * Failures retry rather than abandoning the enrolment. Making someone restart
 * the whole two-impression sequence because one frame smudged is how enrolment
 * becomes the step everyone dreads, and this is a workforce with worn hands.
 */
static bool captureInto(uint8_t slotBuffer, const char *prompt) {
  Serial.println(prompt);

  for (int attempt = 1; attempt <= 6; ++attempt) {
    while (true) {
      uint8_t r = finger.getImage();
      if (r == FINGERPRINT_OK) break;
      if (r == FINGERPRINT_NOFINGER) { delay(60); continue; }
      Serial.printf("  reader error 0x%02X\n", r);
      return false;
    }

    // Contact made. Let the finger flatten against the platen, then take the
    // frame we actually keep.
    delay(350);

    if (finger.getImage() != FINGERPRINT_OK) {
      Serial.println("  finger lifted too soon — press and hold until it says captured");
      delay(300);
      continue;
    }

    if (finger.image2Tz(slotBuffer) == FINGERPRINT_OK) {
      Serial.println("  captured");
      return true;
    }

    Serial.printf("  image too smudged (try %d of 6) — press flat, do not roll\n",
                  attempt);
    delay(600);
  }

  Serial.println("  no clean image after 6 tries.");
  Serial.println("  Wipe the platen and the fingertip. A slightly damp finger");
  Serial.println("  reads far better than a dry one — breathe on it and retry.");
  return false;
}

// ── commands ────────────────────────────────────────────────────────────────

static void doEnrol() {
  long slot = readNumber("Slot to enrol into (1..127): ", 1, 127);

  if (!captureInto(1, "Place the finger on the reader and HOLD it...")) {
    waitForLift();
    return;
  }
  waitForLift();

  Serial.println("Now place the SAME finger, the same way, in 2 seconds...");
  delay(2000);

  if (!captureInto(2, "Place it now and HOLD...")) {
    waitForLift();
    return;
  }

  if (finger.createModel() != FINGERPRINT_OK) {
    // Almost always the finger landing at a different angle the second time,
    // not a broken reader.
    Serial.println("The two impressions did not match each other.");
    Serial.println("Place the finger the same way both times — same angle, same");
    Serial.println("part of the pad. Press e and start this slot again.");
    waitForLift();
    return;
  }
  if (finger.storeModel((uint16_t)slot) != FINGERPRINT_OK) {
    Serial.println("Could not store the template.");
    waitForLift();
    return;
  }
  finger.getTemplateCount();
  Serial.printf("Stored in slot %ld. %u template(s) on the module.\n", slot,
                finger.templateCount);
  Serial.println("Lift the finger, then press it again to test the match.\n");
  waitForLift();
}

static void doDelete() {
  long slot = readNumber("Slot to delete (1..127): ", 1, 127);
  bool ok = finger.deleteModel((uint16_t)slot) == FINGERPRINT_OK;
  Serial.println(ok ? "Deleted." : "Could not delete that slot.");
  finger.getTemplateCount();
  Serial.printf("%u template(s) remaining.\n\n", finger.templateCount);
}

static void doCount() {
  finger.getTemplateCount();
  Serial.printf("%u template(s) stored on the module.\n\n", finger.templateCount);
}

/** Poll for a finger and report what the module said about it. */
static void pollMatch() {
  if (finger.getImage() != FINGERPRINT_OK) return;

  // Same reason as enrolment: the frame taken the instant contact is made is
  // usually smeared. Settle, then take the one we judge.
  delay(250);
  if (finger.getImage() != FINGERPRINT_OK) return;
  if (finger.image2Tz() != FINGERPRINT_OK) return;

  if (finger.fingerFastSearch() != FINGERPRINT_OK) {
    Serial.println("finger seen  ->  no enrolled match");
    waitForLift();
    return;
  }
  // Slot and score are the only things the module ever gives up. No image, no
  // template — which is exactly why the ledger can record a biometric event
  // without ever holding a biometric.
  Serial.printf("MATCH  slot %u  score %u\n", finger.fingerID, finger.confidence);
  waitForLift();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  uint32_t start = millis();
  while (!Serial && millis() - start < 3000) delay(50);
  delay(400);

  Serial.println();
  Serial.println("R307 / AS608 bench check");
  Serial.printf("  chip     %s\n", ESP.getChipModel());
  Serial.printf("  UART1    RX=GPIO%d (<- module TXD), TX=GPIO%d (-> module RXD)\n",
                FP_RX, FP_TX);
  Serial.printf("  baud     %d\n", FP_BAUD);
  Serial.println();

  fpSerial.begin(FP_BAUD, SERIAL_8N1, FP_RX, FP_TX);
  delay(100);

  if (!finger.verifyPassword()) {
    // A real handshake with the module, not an inference from the wiring. If
    // this fails the fault is in one of four places and the list below is
    // ordered by how often each one is actually the cause.
    Serial.println("NO MODULE FOUND on those pins.");
    Serial.println();
    Serial.println("  1. TX/RX not crossed. Module TXD must go to the RX pin above.");
    Serial.println("     This is the most common cause by a wide margin.");
    Serial.println("  2. Power. Measure V+ to GND AT THE MODULE. A genuine R307");
    Serial.println("     (round metal barrel) wants 4.2-6V; AS608/ZFM-20 parts");
    Serial.println("     want 3.3V. If unsure start at 3.3V - underpowering is");
    Serial.println("     recoverable, overvolting is not.");
    Serial.println("  3. No common ground between the module and the board.");
    Serial.println("  4. Baud. 57600 is the factory default; change it only if");
    Serial.println("     you deliberately reconfigured the reader.");
    Serial.println();
    Serial.println("  NOTE: ESP32 GPIOs are not 5V tolerant. If the module runs at");
    Serial.println("  5V, put 1k in series on its TXD with 2k to ground before the");
    Serial.println("  RX pin. The other direction needs nothing.");
    while (true) delay(1000);
  }

  Serial.println("Module answered.");
  finger.getTemplateCount();
  Serial.printf("  %u template(s) stored\n", finger.templateCount);
  Serial.printf("  capacity %u\n", finger.capacity);
  Serial.println();
  Serial.println("Commands:  e = enrol   d = delete   c = count");
  Serial.println("Or just present a finger.");
  Serial.println();
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    while (Serial.available()) Serial.read();
    switch (c) {
      case 'e': case 'E': doEnrol();  return;
      case 'd': case 'D': doDelete(); return;
      case 'c': case 'C': doCount();  return;
      default: break;
    }
  }
  pollMatch();
  delay(50);
}
