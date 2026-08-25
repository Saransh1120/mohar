/**
 * Fingerprint enrolment — run once per person, per centre, per exam cycle.
 *
 * Build and flash with `pio run -e enrol -t upload`, then drive it from the
 * serial monitor. Re-flash the `witness` environment afterwards; the templates
 * stay behind on the R307's own flash, which is the point.
 *
 * Two rules that are policy, not convenience:
 *
 *  1. Enrol locally. Nothing here touches Aadhaar, and nothing should. Aadhaar
 *     -linked biometrics carry statutory restrictions you do not want anywhere
 *     near this, and a locally enrolled template is throwaway by design: wipe
 *     the module at the end of the cycle and the biometric relationship ends.
 *
 *  2. Enrol three fingers per person. Optical readers fail on dry, worn and
 *     work-hardened hands, which is precisely the workforce running an exam
 *     centre. Slots below OBSERVER_SLOT_MIN belong to the superintendent, at or
 *     above it to the observer — the station reads the role off the slot.
 */

#include <Adafruit_Fingerprint.h>
#include <Arduino.h>

#include "station_config.h"

static HardwareSerial fpSerial(1);
static Adafruit_Fingerprint finger(&fpSerial);

static uint16_t readSlot() {
  Serial.print("Slot to enrol into (1..127, <");
  Serial.print(OBSERVER_SLOT_MIN);
  Serial.println(" = superintendent, >= = observer): ");
  while (true) {
    while (!Serial.available()) delay(50);
    long v = Serial.parseInt();
    if (v >= 1 && v <= 127) return static_cast<uint16_t>(v);
    Serial.println("Out of range. Try again.");
  }
}

static bool captureInto(uint8_t buffer, const char *prompt) {
  Serial.println(prompt);
  while (true) {
    uint8_t r = finger.getImage();
    if (r == FINGERPRINT_OK) break;
    if (r == FINGERPRINT_NOFINGER) {
      delay(80);
      continue;
    }
    Serial.printf("  reader error 0x%02x\n", r);
    return false;
  }
  if (finger.image2Tz(buffer) != FINGERPRINT_OK) {
    Serial.println("  could not extract features — clean the platen and retry");
    return false;
  }
  Serial.println("  captured");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  fpSerial.begin(57600, SERIAL_8N1, PIN_FP_RX, PIN_FP_TX);

  Serial.println();
  Serial.println("Mohar — fingerprint enrolment");

  if (!finger.verifyPassword()) {
    Serial.println("No fingerprint module on the configured UART pins. Check that");
    Serial.println("PIN_FP_RX goes to the module's TX and PIN_FP_TX to its RX.");
    while (true) delay(1000);
  }
  finger.getTemplateCount();
  Serial.printf("Module ready. %u templates currently stored.\n", finger.templateCount);
  Serial.println("Type a slot number and press enter.");
}

void loop() {
  uint16_t slot = readSlot();

  if (!captureInto(1, "Place the finger on the reader…")) return;
  Serial.println("Lift the finger.");
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(80);

  if (!captureInto(2, "Place the same finger again…")) return;

  if (finger.createModel() != FINGERPRINT_OK) {
    Serial.println("The two impressions did not agree. Start this slot again.");
    return;
  }
  if (finger.storeModel(slot) != FINGERPRINT_OK) {
    Serial.println("Could not store the template.");
    return;
  }

  finger.getTemplateCount();
  Serial.printf("Stored in slot %u (%s). %u templates on the module.\n", slot,
                slot >= OBSERVER_SLOT_MIN ? "observer" : "superintendent",
                finger.templateCount);
  Serial.println();
  Serial.println("Record the slot number against the person's name in the centre's");
  Serial.println("roster. The ledger will only ever say \"slot 3 matched\" — the");
  Serial.println("mapping from slot to person lives in ref.person, not in the chain.");
  Serial.println();
}
