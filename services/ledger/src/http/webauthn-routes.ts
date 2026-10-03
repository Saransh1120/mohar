import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { z } from "zod";
import { withTransaction } from "../db.js";
import { accountForToken } from "../domain/accounts.js";
import { AssertionResponse, RegistrationResponse, credentialsOf, relyingParty, verifyAssertion, verifyRegistration } from "../domain/webauthn.js";
import { bearerToken } from "./auth-routes.js";

const Uuid = z.string().uuid();
const RegisterBody = z.object({ personId: Uuid });
const CompleteBody = z.object({ personId: Uuid, challengeId: Uuid, response: RegistrationResponse });
const TransferChallengeBody = z.object({ personId: Uuid, deviceId: Uuid });
export const TransferAssertion = z.object({ challengeId: Uuid, response: AssertionResponse });
export type TransferAssertion = z.infer<typeof TransferAssertion>;
export type TransferStep = "dispatch" | "receive" | "confirm";

interface ChallengeRow {
  challenge: string;
  person_id: string;
  device_id: string | null;
  leg_id: string | null;
  step: string | null;
}

/** The same transaction records challenge consumption and the transfer ruling. */
export async function checkTransferAssertion(
  tx: PoolClient,
  input: { personId?: string | undefined; deviceId: string; legId: string; step: TransferStep; webauthn?: TransferAssertion | undefined },
): Promise<{ passed: boolean | undefined; evidence: string }> {
  if (!input.personId) return { passed: input.webauthn ? false : undefined, evidence: "no person was named for WebAuthn" };
  const { rows } = await tx.query<{ webauthn_cred: unknown }>(
    `select webauthn_cred from ref.person where id=$1::uuid for update`, [input.personId]);
  let credentials;
  try { credentials = credentialsOf(rows[0]?.webauthn_cred ?? []); }
  catch { return { passed: false, evidence: "the person's stored credential cannot be read" }; }
  if (!input.webauthn) {
    return credentials.length > 0
      ? { passed: false, evidence: "a credential is enrolled for this person but no WebAuthn assertion was sent" }
      : { passed: undefined, evidence: "not evaluated: no platform credential is enrolled; simulated fingerprint mode" };
  }
  if (credentials.length === 0) return { passed: false, evidence: "no platform credential is enrolled for this person" };
  const { rows: challenges } = await tx.query<ChallengeRow>(
    `update ref.webauthn_challenge set consumed_at=now()
       where id=$1::uuid and purpose='transfer' and consumed_at is null and expires_at>now()
         and person_id=$2::uuid and device_id=$3::uuid and leg_id=$4::uuid and step=$5
       returning challenge, person_id, device_id, leg_id, step`,
    [input.webauthn.challengeId, input.personId, input.deviceId, input.legId, input.step]);
  const challenge = challenges[0];
  if (!challenge || challenge.person_id !== input.personId || challenge.device_id !== input.deviceId ||
      challenge.leg_id !== input.legId || challenge.step !== input.step) {
    return { passed: false, evidence: "the challenge is missing, expired, used, or belongs to another person, device, leg or step" };
  }
  const stored = credentials.find((c) => c.id === input.webauthn!.response.id);
  if (!stored) return { passed: false, evidence: "the assertion credential is not enrolled for this person" };
  try {
    const counter = await verifyAssertion(input.webauthn.response, stored, challenge.challenge, relyingParty());
    stored.counter = counter;
    await tx.query(`update ref.person set webauthn_cred=$2::jsonb where id=$1::uuid`,
      [input.personId, JSON.stringify(credentials)]);
    return { passed: true, evidence: `enrolled WebAuthn credential verified a user for ${input.step}; signature, challenge, origin, RP ID, user-verification flag and counter passed` };
  } catch {
    return { passed: false, evidence: "WebAuthn assertion failed signature, challenge, origin, RP ID, user verification or counter check" };
  }
}

export function registerWebAuthnRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/webauthn/register/challenge", async (req, reply) => {
    const account = await accountForToken(pool, bearerToken(req));
    if (account?.role !== "control_room") return reply.code(403).send({ error: "control room operator required" });
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "personId must be a UUID" });
    const { rows } = await pool.query<{ display_name: string; webauthn_cred: unknown }>(
      `select display_name, webauthn_cred from ref.person where id=$1::uuid`, [parsed.data.personId]);
    const person = rows[0];
    if (!person) return reply.code(404).send({ error: "person not found" });
    if (credentialsOf(person.webauthn_cred).length > 0) return reply.code(409).send({ error: "this person already has a platform credential" });
    const rp = relyingParty();
    const options = await generateRegistrationOptions({
      rpName: rp.name, rpID: rp.rpId, userName: person.display_name,
      userID: Buffer.from(parsed.data.personId.replaceAll("-", ""), "hex"),
      userDisplayName: person.display_name, attestationType: "none",
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      supportedAlgorithmIDs: [-7, -257], timeout: 60_000,
    });
    const { rows: created } = await pool.query<{ id: string }>(
      `insert into ref.webauthn_challenge (purpose, person_id, challenge, expires_at)
       values ('register',$1::uuid,$2,now() + interval '5 minutes') returning id`,
      [parsed.data.personId, options.challenge]);
    return reply.code(201).send({ challengeId: created[0]!.id, options });
  });

  app.post("/webauthn/register/complete", async (req, reply) => {
    const account = await accountForToken(pool, bearerToken(req));
    if (account?.role !== "control_room") return reply.code(403).send({ error: "control room operator required" });
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid registration response" });
    const result = await withTransaction(pool, async (tx) => {
      const { rows: challenges } = await tx.query<ChallengeRow>(
        `update ref.webauthn_challenge set consumed_at=now()
           where id=$1::uuid and purpose='register' and person_id=$2::uuid
             and consumed_at is null and expires_at>now()
           returning challenge, person_id, device_id, leg_id, step`,
        [parsed.data.challengeId, parsed.data.personId]);
      if (!challenges[0]) return { status: 409, error: "registration challenge expired or already used" };
      const { rows } = await tx.query<{ webauthn_cred: unknown }>(
        `select webauthn_cred from ref.person where id=$1::uuid for update`, [parsed.data.personId]);
      if (!rows[0]) return { status: 404, error: "person not found" };
      if (credentialsOf(rows[0].webauthn_cred).length > 0) return { status: 409, error: "this person already has a platform credential" };
      try {
        const credential = await verifyRegistration(parsed.data.response, challenges[0].challenge, relyingParty());
        await tx.query(`update ref.person set webauthn_cred=$2::jsonb where id=$1::uuid`,
          [parsed.data.personId, JSON.stringify([credential])]);
        return { status: 201, credentialId: credential.id };
      } catch {
        return { status: 400, error: "platform credential registration failed challenge, origin, RP ID or user-verification check" };
      }
    });
    return reply.code(result.status).send(result);
  });

  for (const step of ["dispatch", "receive", "confirm"] as const) {
    app.post<{ Params: { legId: string } }>(`/legs/:legId/${step}/webauthn/challenge`, async (req, reply) => {
      const parsed = TransferChallengeBody.safeParse(req.body);
      if (!Uuid.safeParse(req.params.legId).success || !parsed.success) return reply.code(400).send({ error: "invalid leg, person or device" });
      const b = parsed.data;
      const { rows } = await pool.query<{ webauthn_cred: unknown; leg: boolean; device: boolean }>(
        `select p.webauthn_cred,
                exists(select 1 from ref.route_leg where id=$2::uuid) as leg,
                exists(select 1 from ref.device where id=$3::uuid and revoked_at is null) as device
           from ref.person p where p.id=$1::uuid`, [b.personId, req.params.legId, b.deviceId]);
      const person = rows[0];
      if (!person || !person.leg || !person.device) return reply.code(404).send({ error: "person, leg or device not found" });
      const credentials = credentialsOf(person.webauthn_cred);
      if (credentials.length === 0) return reply.code(409).send({ error: "person has no registered platform credential" });
      const options = await generateAuthenticationOptions({
        rpID: relyingParty().rpId, userVerification: "required", timeout: 60_000,
        allowCredentials: credentials.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports } : {}) })),
      });
      const { rows: created } = await pool.query<{ id: string }>(
        `insert into ref.webauthn_challenge
           (purpose,person_id,device_id,leg_id,step,challenge,expires_at)
         values ('transfer',$1::uuid,$2::uuid,$3::uuid,$4,$5,now() + interval '5 minutes') returning id`,
        [b.personId, b.deviceId, req.params.legId, step, options.challenge]);
      return reply.code(201).send({ challengeId: created[0]!.id, options });
    });
  }
}
