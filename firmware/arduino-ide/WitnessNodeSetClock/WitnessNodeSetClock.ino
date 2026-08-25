/**
 * Set the witness node's DS3231 once, from the host clock at build time.
 *
 * Flash this, check the printed time, then flash the node firmware again. The
 * DS3231 keeps time on its coin cell afterwards; this is a provisioning step,
 * not part of normal operation.
 *
 * `__DATE__`/`__TIME__` are the *compiler's* local time, so this is only correct
 * if the build machine is on UTC — which most are not. Set
 * BUILD_UTC_OFFSET_MINUTES to your offset and the sketch subtracts it.
 * Everything downstream assumes UTC: the `Timestamp` primitive ends in `Z`, and
 * a node running on local time puts a five-and-a-half-hour skew inside every
 * signed body and makes the two-person window meaningless.
 *
 * Note what this does NOT do: it never runs at runtime, and the node never
 * corrects its own clock from the network. The ledger records device time and
 * server time separately and reconciles neither, because a device that quietly
 * rewrites its clock to match a server destroys the evidence that the two ever
 * disagreed. Drift is a finding.
 */

#include <Arduino.h>
#include <RTClib.h>
#include <Wire.h>

#include "node_config.h"

// India Standard Time is UTC+5:30 -> 330. Use 0 if the build machine is on UTC.
#define BUILD_UTC_OFFSET_MINUTES 330

static RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  Serial.println();
  Serial.println("Mohar - set the witness node clock");

  if (!rtc.begin()) {
    Serial.printf("No DS3231 on SDA=GPIO%d SCL=GPIO%d.\n", PIN_I2C_SDA, PIN_I2C_SCL);
    Serial.println("Check the wiring and the 3V3 rail.");
    while (true) delay(1000);
  }

  bool wasLost = rtc.lostPower();

  DateTime local(F(__DATE__), F(__TIME__));
  DateTime utc(local.unixtime() - static_cast<int32_t>(BUILD_UTC_OFFSET_MINUTES) * 60);
  rtc.adjust(utc);

  DateTime now = rtc.now();
  char iso[25];
  snprintf(iso, sizeof(iso), "%04u-%02u-%02uT%02u:%02u:%02u.000Z", now.year(),
           now.month(), now.day(), now.hour(), now.minute(), now.second());

  Serial.printf("Coin cell state before: %s\n",
                wasLost ? "power had been lost" : "time was still running");
  Serial.printf("DS3231 now set to      %s\n", iso);
  Serial.println();
  Serial.println("Compare that against `date -u` on the host before trusting it.");
  Serial.println("If it is wrong, fix BUILD_UTC_OFFSET_MINUTES and re-upload.");
  Serial.println();
  Serial.println("Then flash WitnessNode again.");
  Serial.println();
  Serial.println("If the clock keeps coming back to 2000-01-01 after a power cut,");
  Serial.println("the CR2032 is dead or not seated - replace it, or every record");
  Serial.println("this node signs will carry a 26-year skew.");
}

void loop() { delay(1000); }
