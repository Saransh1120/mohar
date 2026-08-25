#include "mohar_time.h"

namespace mohar {

bool Clock::begin() {
  if (!rtc_.begin()) return false;
  lastSecond_ = rtc_.now().unixtime();
  lastTickMs_ = millis();
  return true;
}

bool Clock::lostPower() { return rtc_.lostPower(); }

void Clock::set(const DateTime &utc) {
  rtc_.adjust(utc);
  lastSecond_ = rtc_.now().unixtime();
  lastTickMs_ = millis();
}

uint32_t Clock::unixTime() { return rtc_.now().unixtime(); }

void Clock::nowIso(char out[25]) {
  DateTime now = rtc_.now();
  uint32_t secs = now.unixtime();

  // Re-anchor the millisecond origin whenever the RTC second changes. Between
  // ticks we interpolate with millis(); the value is clamped so a long blocking
  // call (an Ed25519 signature, a camera capture) can never push the fraction
  // past 999 and produce a timestamp a second in the future.
  if (secs != lastSecond_) {
    lastSecond_ = secs;
    lastTickMs_ = millis();
  }
  uint32_t frac = millis() - lastTickMs_;
  if (frac > 999) frac = 999;

  snprintf(out, 25, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.year(), now.month(),
           now.day(), now.hour(), now.minute(), now.second(),
           static_cast<unsigned>(frac));
}

}  // namespace mohar
