import { assertNoNulls, canonicalBytes } from "@mohar/crypto-core";
import type { EventBody } from "@mohar/contracts";
import { authHeaders } from "./api";

/**
 * ── The centre PC as a signing device ────────────────────────────────────────
 *
 * `api.ts` says the UI never constructs a signed event, and until now that was
 * true: writes into the chain came from attested devices only. The witness
 * ceremony changes that, because the photograph is taken by this machine's
 * camera and nothing else is in a position to attest to it.
 *
 * So this browser becomes an enrolled device, and this module is the one place
 * in the control room that signs.
 *
 * The private key is a WebCrypto Ed25519 key generated as non-extractable and
 * kept in IndexedDB as a `CryptoKey` handle. Script on this page can ask the
 * browser to sign with it; nothing can read the key bytes out, so a copied
 * profile export, a stolen `localStorage` dump or an injected script that only
 * gets to read storage does not walk away with the key. `localStorage` holds
 * the device id and the public half and nothing else.
 *
 * What that does not buy has to be stated rather than absorbed. The key is
 * bound to this browser profile, not to the TPM; the enrolment is not
 * attested; and anyone who can run script in this origin, or sit at this
 * unlocked machine, can still have the browser sign as this centre. `docs/02`
 * specifies a TPM-bound `centre_pc` credential and `adr/0003` records that
 * attestation verification does not exist yet; this narrows that gap and does
 * not close it.
 *
 * What it still buys: the frame hash is committed to an append-only chain at
 * the moment of capture, by a named device, alongside a fingerprint assertion
 * signed by a *different* device. Substituting a photograph afterwards is
 * impossible; substituting one at the time requires control of this machine and
 * leaves a signed record saying which device did it.
 */

const STORAGE_KEY = "mohar.centre-pc.identity";

/** Who this browser is. The private key is not here: see `privateKeyFor`. */
export interface CentreIdentity {
  deviceId: string;
  publicKeyHex: string;
  centreId?: string;
}

/** What an earlier version kept in `localStorage`, private key and all. */
interface StoredIdentity extends CentreIdentity {
  privateKeyHex?: string;
}

function readStored(): StoredIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredIdentity;
    return v.deviceId && v.publicKeyHex ? v : null;
  } catch {
    return null;
  }
}

export function loadIdentity(): CentreIdentity | null {
  const v = readStored();
  if (!v) return null;
  return {
    deviceId: v.deviceId,
    publicKeyHex: v.publicKeyHex,
    ...(v.centreId ? { centreId: v.centreId } : {}),
  };
}

export function forgetIdentity(): void {
  const v = readStored();
  localStorage.removeItem(STORAGE_KEY);
  if (v) void keyStore("readwrite", (s) => s.delete(v.deviceId)).catch(() => {});
}

// ── where the key is kept ───────────────────────────────────────────────────

const KEY_DB = "mohar-device-keys";
const KEY_STORE = "keys";
const ED25519 = { name: "Ed25519" } as const;

/** One request against the key store. IndexedDB can hold a CryptoKey as it is. */
export function keyStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KEY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(KEY_STORE);
    open.onerror = () => reject(open.error ?? new Error("could not open the key store"));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(KEY_STORE, mode);
      const req = run(tx.objectStore(KEY_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("the key store refused the request"));
      };
    };
  });
}

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The fixed PKCS#8 wrapper for a raw 32-byte Ed25519 private key (RFC 8410). */
const PKCS8_ED25519_PREFIX = fromHex("302e020100300506032b657004220420");

/**
 * The signing key for this browser's identity.
 *
 * A browser paired by an earlier version still has its private key as hex in
 * `localStorage`. The first time it signs, that key is imported as
 * non-extractable, moved into the key store, and the hex is erased, so the
 * device keeps its enrolment and stops carrying a readable key.
 */
async function privateKeyFor(identity: CentreIdentity): Promise<CryptoKey> {
  const kept = await keyStore<CryptoKey | undefined>("readonly", (s) => s.get(identity.deviceId));
  if (kept) return kept;

  const legacy = readStored();
  if (legacy?.deviceId === identity.deviceId && legacy.privateKeyHex) {
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    pkcs8.set(PKCS8_ED25519_PREFIX, 0);
    pkcs8.set(fromHex(legacy.privateKeyHex), PKCS8_ED25519_PREFIX.length);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, ED25519, false, ["sign"]);
    await keyStore("readwrite", (s) => s.put(key, identity.deviceId));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    return key;
  }
  throw new Error(
    "This browser is paired but its signing key is gone, which happens when site data is " +
      "cleared. Forget this device and pair again.",
  );
}

/**
 * Enrol this browser as a `centre_pc` device.
 *
 * The keypair is generated by the browser, non-extractable, and only the public
 * half is sent. A private key that script cannot read cannot be intercepted on
 * the way to enrolment or copied out afterwards.
 */
export async function pairThisBrowser(centreId?: string): Promise<CentreIdentity> {
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey(ED25519, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    // No fallback to a key held in script: a browser that cannot keep the key
    // out of reach is not paired at all.
    throw new Error(
      "This browser cannot create a non-extractable Ed25519 key. Use a current Chrome, " +
        "Edge, Firefox or Safari to pair this machine.",
    );
  }
  const publicKeyHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const res = await fetch("/api/devices", {
    method: "POST",
    // Enrolment is a control room operator's: the gateway wants the session.
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      kind: "centre_pc",
      pubkeyHex: publicKeyHex,
      ...(centreId ? { centreId } : {}),
    }),
  });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) {
    throw new Error(body.error ?? `enrolment failed (${res.status})`);
  }
  const identity: CentreIdentity = {
    deviceId: body.id,
    publicKeyHex,
    ...(centreId ? { centreId } : {}),
  };
  await keyStore("readwrite", (s) => s.put(pair.privateKey, identity.deviceId));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

/** RFC 3339 UTC with exactly three fractional digits — what `Timestamp` demands. */
export const nowTimestamp = (): string => new Date().toISOString();

export type PostOutcome =
  | { status: "appended"; seq: string; hash: string }
  | { status: "duplicate"; seq: string }
  | { status: "rejected"; code: string; detail: string };

/**
 * Sign a body with this browser's key and append it.
 *
 * The bytes signed are the RFC 8785 canonical form from `@mohar/crypto-core` —
 * the same module the services use. Reimplementing canonicalisation here would
 * be a second definition of "the bytes we signed", and the first time the two
 * disagreed every signature from this browser would silently stop verifying.
 * Only the signature itself is made by the browser, because the key never
 * leaves it; Ed25519 is deterministic, so the ledger verifies it exactly as it
 * verifies one made by a board.
 */
export async function signAndPost(
  body: EventBody,
  identity: CentreIdentity,
): Promise<PostOutcome> {
  assertNoNulls(body);
  const key = await privateKeyFor(identity);
  const deviceSig = toHex(
    new Uint8Array(await crypto.subtle.sign(ED25519, key, canonicalBytes(body) as BufferSource)),
  );
  const res = await fetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, deviceSig }),
  });
  const out = (await res.json()) as Record<string, unknown>;
  if (res.status === 201) {
    return { status: "appended", seq: String(out["seq"]), hash: String(out["hash"]) };
  }
  if (res.status === 200) return { status: "duplicate", seq: String(out["seq"]) };
  return {
    status: "rejected",
    code: String(out["code"] ?? "unknown"),
    detail: JSON.stringify(out),
  };
}

// ── the camera ──────────────────────────────────────────────────────────────

export interface CapturedFrame {
  blob: Blob;
  sha256: string;
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * Grab one still from a running video element and hash the exact bytes.
 *
 * The hash is taken over the encoded JPEG, not the canvas pixels, because the
 * JPEG is the artefact that gets stored and later re-hashed by whoever is
 * checking the commitment. Hashing anything else would produce a commitment
 * that nothing on disk can ever satisfy.
 */
export async function captureFrame(video: HTMLVideoElement): Promise<CapturedFrame> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("the camera has not produced a frame yet");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context");
  ctx.drawImage(video, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("could not encode the frame");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { blob, sha256, width, height, dataUrl: canvas.toDataURL("image/jpeg", 0.85) };
}
