#pragma once
#include <Arduino.h>
#include <RTClib.h>

/**
 * The DS3231 is the device's own clock and the only authority it has offline.
 *
 * It is never corrected from the network at runtime. `docs/learn` Part H.2 is
 * explicit about why: the ledger records device time and server time separately
 * (`clock_skew_ms`) and never reconciles one with the other, because a device
 * that quietly rewrites its own clock to match a server destroys the evidence
 * that the two ever disagreed. Drift is a finding, not a defect to be hidden.
 */

namespace mohar {

class Clock {
 public:
  /** Returns false if the DS3231 does not answer on I2C. */
  bool begin();

  /** True if the RTC reports it lost power — its time cannot be trusted. */
  bool lostPower();

  /** Set the RTC. Provisioning only; never called from the main loop. */
  void set(const DateTime &utc);

  /**
   * Current UTC as `YYYY-MM-DDTHH:MM:SS.mmmZ` — exactly three fractional
   * digits, which is what the `Timestamp` primitive in packages/contracts
   * requires. The milliseconds come from `millis()` interpolated between RTC
   * second ticks, so two events in the same second are still ordered.
   */
  void nowIso(char out[25]);

  uint32_t unixTime();

 private:
  RTC_DS3231 rtc_;
  uint32_t lastSecond_ = 0;
  uint32_t lastTickMs_ = 0;
};

}  // namespace mohar
