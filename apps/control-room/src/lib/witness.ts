import { generateKeypair, signBody } from "@mohar/crypto-core";
import type { EventBody } from "@mohar/contracts";

/**
 * ── The centre PC as a signing device ────────────────────────────────────────
 *
 * `api.ts` says the UI never constructs a signed event, and until now that was
 * true: writes into the chain came from attested devices only. The witness
 * ceremony changes that, because the photograph is taken by this machine's
 * camera and nothing else is in a position to attest to it.
 *
 * So this browser becomes an enrolled device — and the cost has to be stated
 * rather than absorbed. The private key lives in `localStorage`. It is not
 * bound to the TPM, the enrolment is not attested, and anyone with access to
 * this profile can sign as this centre. `docs/02` specifies a TPM-bound
 * `centre_pc` credential and `adr/0003` already records that attestation
 * verification does not exist yet; this is that same gap, now load-bearing.
 *
 * What it still buys: the frame hash is committed to an append-only chain at
 * the moment of capture, by a named device, alongside a fingerprint assertion
 * signed by a *different* device. Substituting a photograph afterwards is
 * impossible; substituting one at the time requires control of this machine and
 * leaves a signed record saying which device did it.
 */

const STORAGE_KEY = "mohar.centre-pc.identity";

export interface CentreIdentity {
  deviceId: string;
  privateKeyHex: string;
  publicKeyHex: string;
  centreId?: string;
}

export function loadIdentity(): CentreIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CentreIdentity;
    return v.deviceId && v.privateKeyHex ? v : null;
  } catch {
    return null;
  }
}

export function forgetIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Enrol this browser as a `centre_pc` device.
 *
 * The keypair is generated here and only the public half is sent. A key that
 * never leaves the machine cannot be intercepted on the way to enrolment, which
 * is the one property this flow does get right.
 */
export async function pairThisBrowser(centreId?: string): Promise<CentreIdentity> {
  const kp = generateKeypair();
  const res = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "centre_pc",
      pubkeyHex: kp.publicKeyHex,
      ...(centreId ? { centreId } : {}),
    }),
  });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) {
    throw new Error(body.error ?? `enrolment failed (${res.status})`);
  }
  const identity: CentreIdentity = {
    deviceId: body.id,
    privateKeyHex: kp.privateKeyHex,
    publicKeyHex: kp.publicKeyHex,
    ...(centreId ? { centreId } : {}),
  };
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
 * Signing happens over the RFC 8785 canonical form via `@mohar/crypto-core` —
 * the same module the services use. Reimplementing canonicalisation here would
 * be a second definition of "the bytes we signed", and the first time the two
 * disagreed every signature from this browser would silently stop verifying.
 */
export async function signAndPost(
  body: EventBody,
  identity: CentreIdentity,
): Promise<PostOutcome> {
  const deviceSig = signBody(body, identity.privateKeyHex);
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
