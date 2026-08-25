#pragma once
#include <Arduino.h>

/**
 * Hashing, signing and identifiers — the three primitives every Mohar record
 * needs before it is allowed to leave the device.
 *
 * Ed25519, not HMAC. `docs/06-hardware-spec.md` says "HMAC each record with a
 * per-device key", but nothing in the software has ever accepted an HMAC: the
 * only entrance to the chain is `POST /events`, which verifies an Ed25519
 * signature over the RFC 8785 canonical form of the body against the public key
 * registered in `ref.device` (see services/ledger/src/append.ts). Signing with
 * Ed25519 here means the device is authenticated by exactly the same code path
 * as a field phone, with no monitor-shaped hole in the verifier.
 */

namespace mohar {

/** Lowercase hex of the SHA-256 of `len` bytes. 64 characters plus a NUL. */
void sha256Hex(const uint8_t *data, size_t len, char out[65]);

/** Streaming SHA-256, for hashing a JPEG that is larger than we want to copy. */
class Sha256Stream {
 public:
  Sha256Stream();
  ~Sha256Stream();
  void update(const uint8_t *data, size_t len);
  void finishHex(char out[65]);

 private:
  void *ctx_;
};

/**
 * Ed25519 over the canonical body bytes.
 *
 * `privateKey` is the 32-byte seed — the same value `@noble/curves` calls
 * `privateKeyHex` and that `tools/provision-device` prints. The public key is
 * derived from it at boot and checked against the enrolled one, so a firmware
 * flashed with a key that does not match its device id fails at boot rather
 * than silently emitting events the ledger will reject with 422.
 */
void ed25519Sign(const uint8_t privateKey[32], const uint8_t publicKey[32],
                 const uint8_t *msg, size_t len, char outHex[129]);

void ed25519DerivePublic(const uint8_t privateKey[32], uint8_t outPublic[32]);

/** Parse `2 * n` lowercase hex characters. Returns false on any bad character. */
bool hexToBytes(const char *hex, uint8_t *out, size_t n);
void bytesToHex(const uint8_t *in, size_t n, char *out);

/**
 * A version-4 UUID from the hardware RNG.
 *
 * `esp_random()` is only a true CSPRNG once RF is running; before Wi-Fi is up it
 * degrades to a PRNG. Event ids are idempotency keys rather than secrets, so
 * that is tolerable — but it is why the private key is provisioned off-device
 * and never generated here.
 */
void uuid4(char out[37]);

}  // namespace mohar
