import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

/** An authenticator public key, kept on the person rather than on the phone. */
export const StoredCredential = z.object({
  id: z.string().min(1),
  publicKeyB64: z.string().min(1),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
});
export type StoredCredential = z.infer<typeof StoredCredential>;

export const RegistrationResponse = z.object({
  id: z.string().min(1), rawId: z.string().min(1), type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.unknown()),
  response: z.object({
    clientDataJSON: z.string().min(1), attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }).passthrough(),
});
export const AssertionResponse = z.object({
  id: z.string().min(1), rawId: z.string().min(1), type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.unknown()),
  response: z.object({
    clientDataJSON: z.string().min(1), authenticatorData: z.string().min(1),
    signature: z.string().min(1), userHandle: z.string().optional(),
  }),
});

export interface WebAuthnRelyingParty { rpId: string; origin: string; name: string }
export function relyingParty(env: NodeJS.ProcessEnv = process.env): WebAuthnRelyingParty {
  return {
    rpId: env["WEBAUTHN_RP_ID"] ?? "localhost",
    origin: env["WEBAUTHN_ORIGIN"] ?? "http://localhost:5173",
    name: env["WEBAUTHN_RP_NAME"] ?? "Mohar",
  };
}

export async function verifyRegistration(
  response: z.infer<typeof RegistrationResponse>, challenge: string, rp: WebAuthnRelyingParty,
): Promise<StoredCredential> {
  // The browser was asked for a platform authenticator. Its attachment string
  // is useful evidence, but attestation "none" does not certify hardware type.
  if (response.authenticatorAttachment !== "platform") throw new Error("a platform authenticator was not reported");
  const result = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId,
    requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
  });
  if (!result.verified || !result.registrationInfo.userVerified) throw new Error("user verification was not proved");
  const credential = result.registrationInfo.credential;
  if (credential.id !== response.id) throw new Error("credential ID changed during registration");
  return {
    id: credential.id,
    publicKeyB64: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    ...(credential.transports ? { transports: credential.transports } : {}),
  };
}

export async function verifyAssertion(
  response: z.infer<typeof AssertionResponse>, stored: StoredCredential,
  challenge: string, rp: WebAuthnRelyingParty,
): Promise<number> {
  if (response.id !== stored.id || response.rawId !== stored.id) throw new Error("credential does not belong to this person");
  const result = await verifyAuthenticationResponse({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId,
    requireUserVerification: true,
    credential: {
      id: stored.id,
      publicKey: Buffer.from(stored.publicKeyB64, "base64url"),
      counter: stored.counter,
      ...(stored.transports ? { transports: stored.transports } : {}),
    },
  });
  if (!result.verified || !result.authenticationInfo.userVerified) throw new Error("user verification was not proved");
  return result.authenticationInfo.newCounter;
}

export function credentialsOf(value: unknown): StoredCredential[] {
  return z.array(StoredCredential).parse(value);
}
