import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * ── A device signing a request, not only an event ────────────────────────────
 *
 * A signed event proves which device recorded something. It says nothing about
 * who is asking the hand-off engine to dispatch a leg, or the door engine to
 * open a strong room: those requests carry a `deviceId` in the body, and a
 * device id is a number anyone can type. This is the signature that makes the
 * id mean something. The gateway checks it before the request reaches an engine.
 *
 * The same enrolled Ed25519 key signs both, over different bytes. The first
 * line of what is signed here is a fixed label, so a request signature can
 * never be replayed as an event signature or the other way round: an event is
 * canonical JSON and always starts with `{`.
 *
 * What is signed, one field per line:
 *
 *   MOHAR-REQUEST-v1
 *   POST                          the method, upper case
 *   /legs/<id>/dispatch?x=1       the path and query exactly as sent
 *   2026-10-02T09:30:00.000Z      when the device says it asked
 *   9f2c…                         a nonce, 16 random bytes, hex
 *   e3b0…                         SHA-256 of the body bytes exactly as sent
 *
 * The body is hashed as bytes rather than re-serialised, so nothing between the
 * device and the gateway has to agree on a JSON encoding. The timestamp bounds
 * how long a captured request stays usable and the nonce stops it being used
 * twice inside that bound.
 */

export const REQUEST_SIGNATURE_LABEL = "MOHAR-REQUEST-v1";

/** Header names, lower case as Node presents them. */
export const REQUEST_SIGNATURE_HEADERS = Object.freeze({
  device: "x-mohar-device",
  timestamp: "x-mohar-timestamp",
  nonce: "x-mohar-nonce",
  signature: "x-mohar-signature",
});

export interface SignableRequest {
  method: string;
  /** Path and query string, exactly as it appears on the request line. */
  path: string;
  /** ISO 8601, from the device's clock. */
  timestamp: string;
  /** 32 lowercase hex characters. */
  nonce: string;
  /** The body as sent. Empty for a request with no body. */
  body: Uint8Array;
}

export function requestSigningBytes(r: SignableRequest): Uint8Array {
  return utf8ToBytes(
    [
      REQUEST_SIGNATURE_LABEL,
      r.method.toUpperCase(),
      r.path,
      r.timestamp,
      r.nonce,
      bytesToHex(sha256(r.body)),
    ].join("\n"),
  );
}

export function signRequest(r: SignableRequest, privateKeyHex: string): string {
  return bytesToHex(ed25519.sign(requestSigningBytes(r), hexToBytes(privateKeyHex)));
}

/**
 * Never throws: a truncated key or a signature that is not hex is a refusal to
 * record, not a 500 that hides the attempt.
 */
export function verifyRequestSignature(
  r: SignableRequest,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), requestSigningBytes(r), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/**
 * The four headers a device adds to a request, ready to spread into `fetch`.
 * `body` must be the bytes that are then sent, not an object serialised twice.
 */
export function signedRequestHeaders(
  deviceId: string,
  privateKeyHex: string,
  request: { method: string; path: string; body?: Uint8Array | string },
  now: Date = new Date(),
): Record<string, string> {
  const body =
    request.body === undefined
      ? new Uint8Array(0)
      : typeof request.body === "string"
        ? utf8ToBytes(request.body)
        : request.body;
  const timestamp = now.toISOString();
  const nonce = bytesToHex(randomBytes(16));
  return {
    [REQUEST_SIGNATURE_HEADERS.device]: deviceId,
    [REQUEST_SIGNATURE_HEADERS.timestamp]: timestamp,
    [REQUEST_SIGNATURE_HEADERS.nonce]: nonce,
    [REQUEST_SIGNATURE_HEADERS.signature]: signRequest(
      { method: request.method, path: request.path, timestamp, nonce, body },
      privateKeyHex,
    ),
  };
}
