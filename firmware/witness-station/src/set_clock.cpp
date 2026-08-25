/**
 * Set the DS3231 once, from the host clock at build time.
 *
 *   pio run -e set_clock -t upload
 *
 * `__DATE__`/`__TIME__` are the *compiler's* local time, so this is only correct
 * if the machine doing the build is on UTC. It is not, on most laptops — so set
 * BUILD_UTC_OFFSET_MINUTES to your offset from UTC and the sketch subtracts it.
 * Everything downstream assumes UTC: the `Timestamp` primitive ends in `Z`, and
 * a station running on local time would put a five-and-a-half-hour skew inside
 * every signed body and make the two-person window meaningless.
 *
 * Flash the `witness` environment again afterwards. The DS3231 keeps time on its
 * coin cell; this is a provisioning step, not part of normal operation.
 */

#include <Arduino.h>
#include <RTClib.h>
#include <Wire.h>

#include "station_config.h"

// India Standard Time is UTC+5:30 → 330. Use 0 if the build machine is on UTC.
#define BUILD_UTC_OFFSET_MINUTES 330

static RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  if (!rtc.begin()) {
    Serial.println("No DS3231 on I2C. Check SDA/SCL and the 3V3 rail.");
    while (true) delay(1000);
  }

  DateTime local(F(__DATE__), F(__TIME__));
  DateTime utc(local.unixtime() - static_cast<int32_t>(BUILD_UTC_OFFSET_MINUTES) * 60);
  rtc.adjust(utc);

  char iso[25];
  DateTime now = rtc.now();
  snprintf(iso, sizeof(iso), "%04u-%02u-%02uT%02u:%02u:%02u.000Z", now.year(),
           now.month(), now.day(), now.hour(), now.minute(), now.second());
  Serial.printf("DS3231 set to %s\n", iso);
  Serial.println("Compare that against `date -u` on the host before trusting it.");
  Serial.println("Now flash the `witness` environment.");
}

void loop() { delay(1000); }
