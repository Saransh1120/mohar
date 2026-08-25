#include "mohar_event.h"

namespace mohar {

String jsonEscape(const char *s) {
  String out;
  out.reserve(strlen(s) + 8);
  for (const char *p = s; *p; ++p) {
    unsigned char c = static_cast<unsigned char>(*p);
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (c < 0x20) {
          char esc[7];
          snprintf(esc, sizeof(esc), "\\u%04x", c);
          out += esc;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

bool JsonWriter::guard(const char *key) {
  if (last_.length() > 0 && strcmp(last_.c_str(), key) >= 0) {
    // Not a warning. A body with keys in the wrong order canonicalises to
    // different bytes on the server than the ones we signed, so every event
    // built after this point would be rejected with `signature_invalid`.
    Serial.printf("[mohar] CANONICAL ORDER VIOLATED: \"%s\" after \"%s\"\n", key,
                  last_.c_str());
    broken_ = true;
    return false;
  }
  if (last_.length() > 0) buf_ += ',';
  last_ = key;
  buf_ += '"';
  buf_ += key;
  buf_ += "\":";
  return true;
}

void JsonWriter::str(const char *key, const char *value) {
  if (!guard(key)) return;
  buf_ += '"';
  buf_ += jsonEscape(value);
  buf_ += '"';
}

void JsonWriter::num(const char *key, long long value) {
  if (!guard(key)) return;
  char n[24];
  snprintf(n, sizeof(n), "%lld", value);
  buf_ += n;
}

void JsonWriter::boolean(const char *key, bool value) {
  if (!guard(key)) return;
  buf_ += value ? "true" : "false";
}

void JsonWriter::raw(const char *key, const char *json) {
  if (!guard(key)) return;
  buf_ += json;
}

String JsonWriter::done() {
  buf_ += '}';
  return buf_;
}

bool identityFromHex(Identity &out, const char *deviceId, const char *examId,
                     const char *centreId, const char *packageId,
                     const char *privateKeyHex, const char *publicKeyHex) {
  memset(&out, 0, sizeof(out));
  strlcpy(out.deviceId, deviceId, sizeof(out.deviceId));
  strlcpy(out.examId, examId, sizeof(out.examId));
  strlcpy(out.centreId, centreId ? centreId : "", sizeof(out.centreId));
  strlcpy(out.packageId, packageId ? packageId : "", sizeof(out.packageId));

  if (strlen(privateKeyHex) != 64 || !hexToBytes(privateKeyHex, out.privateKey, 32)) {
    Serial.println("[mohar] private key is not 64 lowercase hex characters");
    return false;
  }

  uint8_t derived[32];
  ed25519DerivePublic(out.privateKey, derived);
  memcpy(out.publicKey, derived, 32);

  if (publicKeyHex && strlen(publicKeyHex) == 64) {
    uint8_t expected[32];
    if (!hexToBytes(publicKeyHex, expected, 32) || memcmp(expected, derived, 32) != 0) {
      // The enrolled public key and the flashed private key belong to different
      // devices. Every event this board signs would be refused, so say so now.
      char got[65];
      bytesToHex(derived, 32, got);
      Serial.println("[mohar] provisioning mismatch — this key is not the enrolled key");
      Serial.printf("[mohar]   enrolled: %s\n", publicKeyHex);
      Serial.printf("[mohar]   derived : %s\n", got);
      return false;
    }
  }
  return true;
}

String signedEvent(const Identity &id, const char *kind, const char *occurredAt,
                   const char *eventId, const char *payloadJson,
                   const char *actorPersonId, const char *packageIdOverride) {
  const char *pkg = packageIdOverride ? packageIdOverride : id.packageId;

  // Envelope keys in ascending ASCII order:
  //   actorDeviceId, actorPersonId, centreId, examId, id, kind, occurredAt,
  //   packageId, payload, v
  JsonWriter b;
  b.str("actorDeviceId", id.deviceId);
  if (actorPersonId && actorPersonId[0]) b.str("actorPersonId", actorPersonId);
  if (id.centreId[0]) b.str("centreId", id.centreId);
  b.str("examId", id.examId);
  b.str("id", eventId);
  b.str("kind", kind);
  b.str("occurredAt", occurredAt);
  if (pkg && pkg[0]) b.str("packageId", pkg);
  b.raw("payload", payloadJson);
  b.num("v", 1);

  if (b.broken()) return String();
  String body = b.done();

  char sig[129];
  ed25519Sign(id.privateKey, id.publicKey,
              reinterpret_cast<const uint8_t *>(body.c_str()), body.length(), sig);

  String out;
  out.reserve(body.length() + 160);
  out += "{\"body\":";
  out += body;
  out += ",\"deviceSig\":\"";
  out += sig;
  out += "\"}";
  return out;
}

}  // namespace mohar
