#pragma once
#include <Arduino.h>

#include "mohar_crypto.h"

/**
 * ── Building a body the ledger will actually accept ──────────────────────────
 *
 * `POST /events` verifies the device signature over `SHA256(JCS(body))`, where
 * JCS is RFC 8785. Rather than port a canonicaliser to the ESP32, we emit the
 * body already in canonical form and sign those exact bytes:
 *
 *   • object keys in ascending UTF-16 code-unit order (plain ASCII order here);
 *   • optional fields OMITTED, never `null` — `{"a":null}` and `{}` are
 *     different byte strings, and `assertNoNulls` in packages/crypto-core
 *     rejects the first outright;
 *   • integers only, printed without a decimal point, because JCS pins number
 *     formatting to ECMAScript `Number::toString` and a device that emits
 *     `12.0` where the server re-canonicalises to `12` produces a signature
 *     nobody can verify;
 *   • timestamps as `YYYY-MM-DDTHH:MM:SS.mmmZ` with exactly three fractional
 *     digits, which is what the `Timestamp` primitive demands.
 *
 * `geo` is omitted from every device event. These devices are bolted to a wall
 * and have no GNSS, and inventing a fix would be a lie inside a signed body.
 * The ledger flags `geo_missing`, which is the truthful record. It also happens
 * to keep every number in the body an integer, which removes the one place
 * floating-point canonicalisation could have bitten us.
 *
 * `JsonWriter` enforces the ordering rule at runtime instead of trusting the
 * author to keep it: an out-of-order key aborts the build rather than producing
 * a body that fails verification later, in the field, with no serial console
 * attached.
 */

namespace mohar {

class JsonWriter {
 public:
  JsonWriter() { buf_.reserve(512); buf_ += '{'; }

  void str(const char *key, const char *value);
  void num(const char *key, long long value);
  void boolean(const char *key, bool value);
  /** Emit a nested object whose text is already canonical. */
  void raw(const char *key, const char *json);

  /** Finish and return the object text. Further writes are undefined. */
  String done();

  /** True if a key was written out of order — the build must be abandoned. */
  bool broken() const { return broken_; }

 private:
  bool guard(const char *key);
  String buf_;
  String last_;
  bool broken_ = false;
};

/** Escape a string into JSON per RFC 8785 (which uses RFC 8259 escaping). */
String jsonEscape(const char *s);

struct Identity {
  char deviceId[37];
  char examId[37];
  char centreId[37];   // empty string means "omit"
  char packageId[37];  // empty string means "omit"
  uint8_t privateKey[32];
  uint8_t publicKey[32];
};

/**
 * Load and validate an identity from the compile-time provisioning constants.
 * Returns false — and explains why on the serial console — if the private key
 * does not derive the enrolled public key. Better to refuse to run than to
 * spend an exam day filling the ledger's log with 422s.
 */
bool identityFromHex(Identity &out, const char *deviceId, const char *examId,
                     const char *centreId, const char *packageId,
                     const char *privateKeyHex, const char *publicKeyHex);

/**
 * Produce the complete request body for `POST /events`:
 *   {"body":{…canonical…},"deviceSig":"<128 hex chars>"}
 *
 * `payloadJson` must be a canonical object, normally built with a JsonWriter.
 * `actorPersonId` may be nullptr; `packageId`/`centreId` come from the identity
 * and are omitted when empty.
 */
String signedEvent(const Identity &id, const char *kind, const char *occurredAt,
                   const char *eventId, const char *payloadJson,
                   const char *actorPersonId = nullptr,
                   const char *packageIdOverride = nullptr);

}  // namespace mohar
