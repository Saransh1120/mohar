/** The browser does the biometric match; only a signed WebAuthn assertion leaves it. */
const bytes = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
const b64url = (value: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

interface CredentialDescriptor { id: string; transports?: AuthenticatorTransport[] }
interface CreationOptions {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: CredentialDescriptor[];
}
interface RequestOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: CredentialDescriptor[];
}

export async function platformAvailable(): Promise<boolean> {
  return typeof PublicKeyCredential !== "undefined" &&
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" &&
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

export async function createPlatformCredential(options: CreationOptions): Promise<Record<string, unknown>> {
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: bytes(options.challenge),
    rp: options.rp,
    user: { ...options.user, id: bytes(options.user.id) },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.attestation ? { attestation: options.attestation } : {}),
    authenticatorSelection: { ...options.authenticatorSelection, authenticatorAttachment: "platform", userVerification: "required" },
    ...(options.excludeCredentials ? { excludeCredentials: options.excludeCredentials.map((c) => ({ type: "public-key" as const, id: bytes(c.id), ...(c.transports ? { transports: c.transports } : {}) })) } : {}),
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("platform authenticator did not create a credential");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id, rawId: b64url(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64url(response.clientDataJSON),
      attestationObject: b64url(response.attestationObject),
      transports: response.getTransports(),
    },
  };
}

export async function getPlatformAssertion(options: RequestOptions): Promise<Record<string, unknown>> {
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: bytes(options.challenge),
    rpId: options.rpId,
    ...(options.timeout ? { timeout: options.timeout } : {}),
    userVerification: "required",
    ...(options.allowCredentials ? { allowCredentials: options.allowCredentials.map((c) => ({ type: "public-key" as const, id: bytes(c.id), ...(c.transports ? { transports: c.transports } : {}) })) } : {}),
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("platform authenticator did not return an assertion");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id, rawId: b64url(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64url(response.clientDataJSON),
      authenticatorData: b64url(response.authenticatorData),
      signature: b64url(response.signature),
      ...(response.userHandle ? { userHandle: b64url(response.userHandle) } : {}),
    },
  };
}
