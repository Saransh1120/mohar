/**
 * The browser's half of an operator's passkey.
 *
 * The ledger sends options with every byte string as base64url; WebAuthn wants
 * ArrayBuffers and hands ArrayBuffers back. This file is that conversion and
 * nothing else. The fingerprint, face or PIN is checked by the authenticator;
 * what leaves this page is a signature over the ledger's challenge.
 *
 * Unlike the courier's phone (apps/field-app), nothing here insists on a
 * platform authenticator: a security key on the desk is as good a thing for an
 * operator to hold.
 */

const bytes = (b64: string): ArrayBuffer =>
  Uint8Array.from(atob(b64.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))
    .buffer as ArrayBuffer;

const b64url = (value: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

interface Descriptor {
  id: string;
  type: "public-key";
  transports?: string[];
}

export interface PasskeyCreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: Descriptor[];
}

export interface PasskeyRequestOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Descriptor[];
}

const described = (list: Descriptor[] | undefined): PublicKeyCredentialDescriptor[] =>
  (list ?? []).map((c) => ({
    type: "public-key" as const,
    id: bytes(c.id),
    ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
  }));

/** Whether this browser can hold or reach a passkey at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

function need(): void {
  if (!passkeysSupported()) {
    throw new Error("This browser has no WebAuthn, so it cannot use a passkey. Use one that does.");
  }
}

export async function passkeyCreate(options: PasskeyCreationOptions): Promise<Record<string, unknown>> {
  need();
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: bytes(options.challenge),
      rp: options.rp,
      user: { ...options.user, id: bytes(options.user.id) },
      pubKeyCredParams: options.pubKeyCredParams,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      attestation: options.attestation ?? "none",
      authenticatorSelection: { ...options.authenticatorSelection, userVerification: "required" },
      excludeCredentials: described(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: b64url(credential.rawId),
    type: credential.type,
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64url(response.clientDataJSON),
      attestationObject: b64url(response.attestationObject),
      transports: response.getTransports(),
    },
  };
}

export async function passkeyAssertion(options: PasskeyRequestOptions): Promise<Record<string, unknown>> {
  need();
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: bytes(options.challenge),
      rpId: options.rpId,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      userVerification: "required",
      allowCredentials: described(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey answered.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: b64url(credential.rawId),
    type: credential.type,
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64url(response.clientDataJSON),
      authenticatorData: b64url(response.authenticatorData),
      signature: b64url(response.signature),
      ...(response.userHandle ? { userHandle: b64url(response.userHandle) } : {}),
    },
  };
}
