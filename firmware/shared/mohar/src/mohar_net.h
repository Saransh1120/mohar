#pragma once
#include <Arduino.h>

#include "mohar_spool.h"

/**
 * Transport to the ledger.
 *
 * The status codes from `POST /events` carry meaning for a device draining a
 * queue, and this client honours all three (services/ledger/src/http/routes.ts):
 *
 *   201 appended   — in the chain; drop it from the spool
 *   200 duplicate  — the ledger already had it; also drop it, this is what makes
 *                    retrying after a lost response safe
 *   422 rejected   — could not be authenticated. Drop it and raise the
 *                    condition. Retrying an unauthenticatable event forever is
 *                    how a queue wedges, and a wedged queue is a device that has
 *                    silently stopped reporting.
 *
 * Anything else — a timeout, a 5xx, no route to host — leaves the record in the
 * spool to be tried again.
 */

namespace mohar {

enum class PostResult { Appended, Duplicate, Rejected, Retry };

/**
 * What the access engine said.
 *
 * `reached` distinguishes "the engine refused" from "we could not ask", which
 * are very different things to signal in a room. A device that buzzes refusal
 * when it simply lost Wi-Fi teaches the officials to ignore the buzzer.
 */
struct AccessDecision {
  bool reached = false;
  bool granted = false;
  String denyReasons;
  int httpStatus = 0;
};

class Ledger {
 public:
  void begin(const char *baseUrl, uint32_t timeoutMs = 8000);

  /** POST one already-signed event body. */
  PostResult post(const String &signedEventJson, String *detail = nullptr);

  /**
   * Ask for an unlock decision.
   *
   * Deliberately unsigned: `POST /access/request` is not an entrance to the
   * chain. The engine records the attempt itself, before returning an answer,
   * so a device that crashes on receipt of a denial has still left evidence.
   * A refusal comes back as HTTP 200 with `outcome: denied` — a denial is a
   * successful evaluation that produced "no", not a transport error.
   */
  AccessDecision requestAccess(const char *packageId, const char *stage,
                               const char *deviceId, const char *sessionId,
                               const char *presentedKey);

  /**
   * Drain up to `maxRecords` from the spool. Stops at the first record that
   * needs retrying, so ordering on the wire matches ordering on the card.
   * Returns the number of records the ledger accepted.
   */
  uint32_t drain(Spool &spool, uint32_t maxRecords = 20);

  uint32_t rejected() const { return rejected_; }

 private:
  String base_;
  uint32_t timeoutMs_ = 8000;
  uint32_t rejected_ = 0;
};

/** Join Wi-Fi, non-fatally. A device with no network still records to SD. */
bool wifiConnect(const char *ssid, const char *password, uint32_t timeoutMs = 15000);

}  // namespace mohar
