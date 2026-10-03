import { strict as assert } from "node:assert";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { test } from "node:test";
import { AssertionResponse, RegistrationResponse, verifyAssertion, verifyRegistration } from "./webauthn.js";

// Fixed ES256 WebAuthn vectors. This private key signs test vectors only and is
// never read by an application route. The RP ID is localhost, origin port 5173.
const PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg6eRGJRfLP+eW9j+/
luyRBKM9uTCckQE6cZ0IW96QUVGhRANCAAQFkDpoAy6wGDhWfqBBNcXJDtdjqcLE
ukWSYpTfiUCwLxsPQPzxXP1Zumy8TEt/+AmNDG2X0uEOamllU16IVWTW
-----END PRIVATE KEY-----`;
const RP = { rpId: "localhost", origin: "http://localhost:5173", name: "Mohar" };
const CHALLENGE = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
const ID = "bW9oYXItdGVzdC1jcmVkMDE";
const PUBLIC_KEY_B64 = "pQECAyYgASFYIAWQOmgDLrAYOFZ-oEE1xckO12OpwsS6RZJilN-JQLAvIlggGw9A_PFc_Vm6bLxMS3_4CY0MbZfS4Q5qaWVTXohVZNY";
const REGISTRATION = RegistrationResponse.parse({
  id: ID, rawId: ID, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTE3MyIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    attestationObject: "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YViVSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAAAAAAAAAAAAAAAAAAAAAAAAEW1vaGFyLXRlc3QtY3JlZDAxpQECAyYgASFYIAWQOmgDLrAYOFZ-oEE1xckO12OpwsS6RZJilN-JQLAvIlggGw9A_PFc_Vm6bLxMS3_4CY0MbZfS4Q5qaWVTXohVZNY",
    transports: ["internal"],
  },
});
const ASSERTION = AssertionResponse.parse({
  id: ID, rawId: ID, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTE3MyIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ",
    signature: "MEQCIH38z95tybTOdBdLdnYKk8ZVrWoOHHqfbsg0R3qTs4-TAiAj8Jj2nU5wK9kvvnwPCpZ4XCluik60sT4nse9c9TnpRQ",
  },
});
const stored = { id: ID, publicKeyB64: PUBLIC_KEY_B64, counter: 0, transports: ["internal"] };
const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const clientWith = (change: Record<string, unknown>) => {
  const current = JSON.parse(Buffer.from(ASSERTION.response.clientDataJSON, "base64url").toString("utf8")) as Record<string, unknown>;
  return b64(JSON.stringify({ ...current, ...change }));
};

test("fixed registration vector binds platform, challenge, origin, RP ID and verified user", async () => {
  const cred = await verifyRegistration(REGISTRATION, CHALLENGE, RP);
  assert.equal(cred.id, ID);
  assert.equal(cred.publicKeyB64, PUBLIC_KEY_B64);
  assert.equal(cred.counter, 0);
});
test("registration refuses wrong challenge, origin, RP ID or non-platform attachment", async () => {
  await assert.rejects(verifyRegistration(REGISTRATION, "wrong", RP));
  await assert.rejects(verifyRegistration(REGISTRATION, CHALLENGE, { ...RP, origin: "https://wrong.example" }));
  await assert.rejects(verifyRegistration(REGISTRATION, CHALLENGE, { ...RP, rpId: "wrong.example" }));
  await assert.rejects(verifyRegistration({ ...REGISTRATION, authenticatorAttachment: "cross-platform" }, CHALLENGE, RP));
});
test("fixed assertion vector checks signature and advances counter", async () => {
  assert.equal(await verifyAssertion(ASSERTION, stored, CHALLENGE, RP), 1);
});
test("assertion refuses wrong challenge, origin, RP ID and credential", async () => {
  await assert.rejects(verifyAssertion(ASSERTION, stored, "wrong", RP));
  await assert.rejects(verifyAssertion(ASSERTION, stored, CHALLENGE, { ...RP, origin: "https://wrong.example" }));
  await assert.rejects(verifyAssertion(ASSERTION, stored, CHALLENGE, { ...RP, rpId: "wrong.example" }));
  await assert.rejects(verifyAssertion(ASSERTION, { ...stored, id: "other" }, CHALLENGE, RP));
});
test("assertion refuses a modified signature and repeated sign counter", async () => {
  const signature = Buffer.from(ASSERTION.response.signature, "base64url");
  signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 1;
  await assert.rejects(verifyAssertion({ ...ASSERTION, response: { ...ASSERTION.response, signature: b64(signature) } }, stored, CHALLENGE, RP));
  await assert.rejects(verifyAssertion(ASSERTION, { ...stored, counter: 1 }, CHALLENGE, RP));
});
test("assertion refuses a correctly signed response with no UV flag", async () => {
  const authenticatorData = Buffer.from(ASSERTION.response.authenticatorData, "base64url");
  authenticatorData[32] = 0x01;
  const clientHash = createHash("sha256").update(Buffer.from(ASSERTION.response.clientDataJSON, "base64url")).digest();
  const signature = sign("sha256", Buffer.concat([authenticatorData, clientHash]), createPrivateKey(PRIVATE_PEM));
  await assert.rejects(verifyAssertion({ ...ASSERTION, response: {
    ...ASSERTION.response, authenticatorData: b64(authenticatorData), signature: b64(signature),
  } }, stored, CHALLENGE, RP));
});
test("assertion refuses client data from another origin even when re-signed", async () => {
  const clientDataJSON = clientWith({ origin: "https://wrong.example" });
  const authData = Buffer.from(ASSERTION.response.authenticatorData, "base64url");
  const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest()]), createPrivateKey(PRIVATE_PEM));
  await assert.rejects(verifyAssertion({ ...ASSERTION, response: {
    ...ASSERTION.response, clientDataJSON, signature: b64(signature),
  } }, stored, CHALLENGE, RP));
});
