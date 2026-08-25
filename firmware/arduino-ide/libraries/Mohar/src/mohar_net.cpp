#include "mohar_net.h"

#include <HTTPClient.h>
#include <WiFi.h>

namespace mohar {

bool wifiConnect(const char *ssid, const char *password, uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(200);
  }
  return WiFi.status() == WL_CONNECTED;
}

void Ledger::begin(const char *baseUrl, uint32_t timeoutMs) {
  base_ = baseUrl;
  while (base_.endsWith("/")) base_.remove(base_.length() - 1);
  timeoutMs_ = timeoutMs;
}

PostResult Ledger::post(const String &signedEventJson, String *detail) {
  if (WiFi.status() != WL_CONNECTED) return PostResult::Retry;

  HTTPClient http;
  http.setTimeout(timeoutMs_);
  http.setConnectTimeout(timeoutMs_);
  if (!http.begin(base_ + "/events")) return PostResult::Retry;
  http.addHeader("content-type", "application/json");

  int code = http.POST(signedEventJson);
  String body = code > 0 ? http.getString() : String();
  http.end();

  if (detail) *detail = body;

  switch (code) {
    case 201:
      return PostResult::Appended;
    case 200:
      return PostResult::Duplicate;
    case 422:
      rejected_++;
      Serial.printf("[mohar] ledger REJECTED an event: %s\n", body.c_str());
      return PostResult::Rejected;
    default:
      return PostResult::Retry;
  }
}

/** Pull one string field out of a JSON response without linking a parser. */
static String field(const String &json, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int at = json.indexOf(needle);
  if (at < 0) return String();
  at += needle.length();
  int end = json.indexOf('"', at);
  return end < 0 ? String() : json.substring(at, end);
}

/** Pull an array field out verbatim, brackets stripped. */
static String arrayField(const String &json, const char *key) {
  String needle = String("\"") + key + "\":[";
  int at = json.indexOf(needle);
  if (at < 0) return String();
  at += needle.length();
  int end = json.indexOf(']', at);
  if (end < 0) return String();
  String out = json.substring(at, end);
  out.replace("\"", "");
  return out;
}

AccessDecision Ledger::requestAccess(const char *packageId, const char *stage,
                                     const char *deviceId, const char *sessionId,
                                     const char *presentedKey) {
  AccessDecision d;
  if (WiFi.status() != WL_CONNECTED) return d;

  String body = "{";
  body += "\"packageId\":\"" + String(packageId) + "\",";
  body += "\"stage\":\"" + String(stage) + "\",";
  body += "\"deviceId\":\"" + String(deviceId) + "\",";
  if (presentedKey && presentedKey[0]) {
    body += "\"presentedKey\":\"" + String(presentedKey) + "\",";
  }
  body += "\"sessionId\":\"" + String(sessionId) + "\"}";

  HTTPClient http;
  http.setTimeout(timeoutMs_);
  http.setConnectTimeout(timeoutMs_);
  if (!http.begin(base_ + "/access/request")) return d;
  http.addHeader("content-type", "application/json");
  int code = http.POST(body);
  String res = code > 0 ? http.getString() : String();
  http.end();

  d.httpStatus = code;
  if (code != 200) return d;

  d.reached = true;
  d.granted = field(res, "outcome") == "granted";
  d.denyReasons = arrayField(res, "denyReasons");
  return d;
}

uint32_t Ledger::drain(Spool &spool, uint32_t maxRecords) {
  uint32_t accepted = 0;
  for (uint32_t i = 0; i < maxRecords; ++i) {
    String line = spool.peek();
    if (line.length() == 0) break;

    PostResult r = post(line);
    if (r == PostResult::Retry) break;  // keep the card's order on the wire

    // Appended, duplicate and rejected all advance the cursor. Only the first
    // two are successes; a rejection is dropped deliberately rather than
    // retried, and the count is surfaced in the heartbeat.
    spool.commit();
    if (r == PostResult::Appended || r == PostResult::Duplicate) accepted++;
  }
  return accepted;
}

}  // namespace mohar
