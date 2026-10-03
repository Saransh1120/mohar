import { REQUEST_SIGNATURE_HEADERS, requestSigningBytes } from "@mohar/crypto-core";
import { keyStore } from "./witness";

/**
 * ── A console acting as a device ─────────────────────────────────────────────
 *
 * The Transfers, Strong rooms and Ceremonies consoles stand in for a device in
 * the field: a courier's handheld, the reader at a door, the station at an
 * opening. The gateway does not take a session for what those devices do. It
 * takes the device's own signature over the request, so the `deviceId` an
 * engine is handed is the device that sent it.
 *
 * So the console holds the device's key. It is an Ed25519 key the browser
 * generates as non-extractable and keeps in IndexedDB beside the centre PC's
 * (`witness.ts`): this page can ask the browser to sign with it and cannot read
 * it out. Only the public half is sent, when the device is enrolled.
 *
 * What that does and does not show. It is real: the gateway verifies each
 * request against the enrolled key, refuses a replay, and refuses a request
 * that names any other device. It is still a browser standing in for a
 * handheld, on the machine of whoever is signed in; a device in the field
 * would hold its key in its own hardware.
 */

const ED25519 = { name: "Ed25519" } as const;

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface NewDeviceKey {
  publicKeyHex: string;
  /** Keep the private half under the id the ledger gave the device. */
  keepAs: (deviceId: string) => Promise<void>;
}

/** A fresh signing key for a device this console is about to enrol. */
export async function newDeviceKey(): Promise<NewDeviceKey> {
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey(ED25519, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    throw new Error(
      "This browser cannot create a non-extractable Ed25519 key, so it cannot act as a device. " +
        "Use a current Chrome, Edge, Firefox or Safari.",
    );
  }
  const publicKeyHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    publicKeyHex,
    keepAs: async (deviceId) => {
      await keyStore("readwrite", (s) => s.put(pair.privateKey, deviceId));
    },
  };
}

/** Whether this browser holds the signing key of a device. */
export async function holdsKeyFor(deviceId: string): Promise<boolean> {
  const key = await keyStore<CryptoKey | undefined>("readonly", (s) => s.get(deviceId)).catch(
    () => undefined,
  );
  return key !== undefined;
}

/**
 * The four signature headers for one request, made with the device's key.
 *
 * `path` is the path the gateway receives, without the `/api` this page's proxy
 * strips, and `body` is the exact text that is then sent.
 */
export async function deviceSignatureHeaders(
  deviceId: string,
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const key = await keyStore<CryptoKey | undefined>("readonly", (s) => s.get(deviceId));
  if (!key) {
    throw new Error(
      `This browser does not hold the key of device ${deviceId.slice(0, 8)}…, so it cannot act ` +
        "as it. That is the case for a device made before consoles signed their requests, or " +
        "in another browser. Make a new one from this page.",
    );
  }
  const timestamp = new Date().toISOString();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const bytes = requestSigningBytes({
    method,
    path,
    timestamp,
    nonce,
    body: new TextEncoder().encode(body),
  });
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes as BufferSource)),
  );
  return {
    [REQUEST_SIGNATURE_HEADERS.device]: deviceId,
    [REQUEST_SIGNATURE_HEADERS.timestamp]: timestamp,
    [REQUEST_SIGNATURE_HEADERS.nonce]: nonce,
    [REQUEST_SIGNATURE_HEADERS.signature]: signature,
  };
}
