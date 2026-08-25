#include "mohar_crypto.h"

#include <Ed25519.h>
#include <esp_random.h>
#include <mbedtls/sha256.h>

namespace mohar {

static const char kHex[] = "0123456789abcdef";

void bytesToHex(const uint8_t *in, size_t n, char *out) {
  for (size_t i = 0; i < n; ++i) {
    out[i * 2] = kHex[in[i] >> 4];
    out[i * 2 + 1] = kHex[in[i] & 0x0f];
  }
  out[n * 2] = '\0';
}

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  // Uppercase is deliberately rejected: `Hex()` in packages/contracts insists on
  // lowercase because mixed case canonicalises to different bytes, and a key
  // that round-trips through an editor in uppercase would fail verification in a
  // way that is very hard to see.
  return -1;
}

bool hexToBytes(const char *hex, uint8_t *out, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    int hi = hexVal(hex[i * 2]);
    int lo = hexVal(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

void sha256Hex(const uint8_t *data, size_t len, char out[65]) {
  uint8_t digest[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);  // 0 = SHA-256, not SHA-224
  mbedtls_sha256_update(&ctx, data, len);
  mbedtls_sha256_finish(&ctx, digest);
  mbedtls_sha256_free(&ctx);
  bytesToHex(digest, 32, out);
}

Sha256Stream::Sha256Stream() {
  auto *c = new mbedtls_sha256_context();
  mbedtls_sha256_init(c);
  mbedtls_sha256_starts(c, 0);
  ctx_ = c;
}

Sha256Stream::~Sha256Stream() {
  auto *c = static_cast<mbedtls_sha256_context *>(ctx_);
  if (c) {
    mbedtls_sha256_free(c);
    delete c;
  }
}

void Sha256Stream::update(const uint8_t *data, size_t len) {
  mbedtls_sha256_update(static_cast<mbedtls_sha256_context *>(ctx_), data, len);
}

void Sha256Stream::finishHex(char out[65]) {
  uint8_t digest[32];
  mbedtls_sha256_finish(static_cast<mbedtls_sha256_context *>(ctx_), digest);
  bytesToHex(digest, 32, out);
}

void ed25519DerivePublic(const uint8_t privateKey[32], uint8_t outPublic[32]) {
  Ed25519::derivePublicKey(outPublic, privateKey);
}

void ed25519Sign(const uint8_t privateKey[32], const uint8_t publicKey[32],
                 const uint8_t *msg, size_t len, char outHex[129]) {
  uint8_t sig[64];
  Ed25519::sign(sig, privateKey, publicKey, msg, len);
  bytesToHex(sig, 64, outHex);
}

void uuid4(char out[37]) {
  uint8_t b[16];
  for (size_t i = 0; i < 16; i += 4) {
    uint32_t r = esp_random();
    b[i] = r & 0xff;
    b[i + 1] = (r >> 8) & 0xff;
    b[i + 2] = (r >> 16) & 0xff;
    b[i + 3] = (r >> 24) & 0xff;
  }
  b[6] = static_cast<uint8_t>((b[6] & 0x0f) | 0x40);  // version 4
  b[8] = static_cast<uint8_t>((b[8] & 0x3f) | 0x80);  // RFC 4122 variant

  char hex[33];
  bytesToHex(b, 16, hex);
  snprintf(out, 37, "%.8s-%.4s-%.4s-%.4s-%.12s", hex, hex + 8, hex + 12, hex + 16,
           hex + 20);
}

}  // namespace mohar
