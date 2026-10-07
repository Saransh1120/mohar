import { randomBytes } from "node:crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { AuthError } from "./accounts.js";
import {
  verifyAssertion,
  type AssertionResponse,
  type RegistrationResponse,
  type StoredCredential,
  type WebAuthnRelyingParty,
} from "./webauthn.js";

/**
 * ── An operator's passkey ────────────────────────────────────────────────────
 *
 * An account with no passkey signs in with its password. An account with one
 * does not: the password earns a challenge, and a session opens only when one
 * of the account's passkeys signs it, with the user verified by the
 * authenticator (a fingerprint, a face, or the device's PIN).
 *
 * What this proves is that the holder of an enrolled key was present and was
 * verified by that key's device. It does not prove what kind of device: the
 * attestation asked for is "none", so a software authenticator enrols as
 * readily as a phone. The registration is not held to a platform
 * authenticator either, unlike a courier's (see webauthn.ts); a security key
 * on a control room desk is as good a thing to hold.
 *
 * Losing every passkey does not lock an account for ever: another operator
 * removes them, and the password works alone again. That is a way in, and it
 * is raised as an alert when it is used.
 */

const NO_TABLE = "42P01";
const CHALLENGE_MINUTES = 5;

const newChallenge = (): string => randomBytes(32).toString("base64url");
const TRANSPORT = /^[a-z-]{1,20}$/;

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[] | null;
  label: string | null;
  added_at: Date;
  last_used_at: Date | null;
}

export interface Passkey {
  id: string;
  label: string | null;
  addedAt: string;
  lastUsedAt: string | null;
}

async function activeRows(db: Pool | PoolClient, accountId: string): Promise<PasskeyRow[]> {
  try {
    const { rows } = await db.query<PasskeyRow>(
      `select id, credential_id, public_key, counter::text as counter, transports, label, added_at, last_used_at
         from ref.account_passkey
        where account_id = $1::uuid and removed_at is null
        order by added_at`,
      [accountId],
    );
    return rows;
  } catch (err) {
    // Before migration 019 nobody can hold a passkey, and sign-in must still work.
    if ((err as { code?: string }).code === NO_TABLE) return [];
    throw err;
  }
}

/** The passkeys an account can sign in with. Never the key material. */
export async function passkeysOf(db: Pool | PoolClient, accountId: string): Promise<Passkey[]> {
  return (await activeRows(db, accountId)).map((r) => ({
    id: r.id,
    label: r.label,
    addedAt: r.added_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  }));
}

const descriptors = (rows: PasskeyRow[]) =>
  rows.map((r) => ({
    id: r.credential_id,
    type: "public-key" as const,
    ...(r.transports?.length ? { transports: r.transports } : {}),
  }));

/** What the browser is asked to make a credential for. */
export async function beginRegistration(
  db: Pool | PoolClient,
  account: { id: string; username: string; displayName: string },
  rp: WebAuthnRelyingParty,
) {
  const challenge = newChallenge();
  const { rows } = await db.query<{ id: string }>(
    `insert into ref.account_challenge (purpose, account_id, challenge, expires_at)
     values ('register', $1::uuid, $2, now() + make_interval(mins => $3)) returning id`,
    [account.id, challenge, CHALLENGE_MINUTES],
  );
  return {
    challengeId: rows[0]!.id,
    options: {
      challenge,
      rp: { id: rp.rpId, name: rp.name },
      user: {
        id: Buffer.from(account.id.replaceAll("-", ""), "hex").toString("base64url"),
        name: account.username,
        displayName: account.displayName,
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 },
        { type: "public-key" as const, alg: -257 },
      ],
      timeout: 60_000,
      attestation: "none" as const,
      authenticatorSelection: { userVerification: "required" as const, residentKey: "discouraged" as const },
      // The same authenticator is not enrolled twice.
      excludeCredentials: descriptors(await activeRows(db, account.id)),
    },
  };
}

/** Take a one-use challenge. Null if it is unknown, spent, expired or another account's. */
async function takeChallenge(
  tx: PoolClient,
  id: string,
  purpose: "register" | "signin",
  accountId: string | null,
): Promise<{ challenge: string; accountId: string } | null> {
  const { rows } = await tx.query<{ challenge: string; account_id: string }>(
    `update ref.account_challenge set consumed_at = now()
      where id = $1::uuid and purpose = $2 and consumed_at is null and expires_at > now()
        and ($3::uuid is null or account_id = $3::uuid)
      returning challenge, account_id`,
    [id, purpose, accountId],
  );
  return rows[0] ? { challenge: rows[0].challenge, accountId: rows[0].account_id } : null;
}

export async function finishRegistration(
  tx: PoolClient,
  accountId: string,
  challengeId: string,
  response: z.infer<typeof RegistrationResponse>,
  label: string | null,
  rp: WebAuthnRelyingParty,
): Promise<Passkey> {
  const taken = await takeChallenge(tx, challengeId, "register", accountId);
  if (!taken) throw new AuthError(409, "That challenge is spent, expired, or was not issued to this account. Start again.");

  let credential;
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: taken.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!result.verified || !result.registrationInfo.userVerified) throw new Error("user verification was not proved");
    credential = result.registrationInfo.credential;
    if (credential.id !== response.id) throw new Error("credential ID changed during registration");
  } catch (err) {
    throw new AuthError(
      422,
      `The passkey did not verify: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
    );
  }

  const transports = (credential.transports ?? []).filter((t) => TRANSPORT.test(t));
  try {
    const { rows } = await tx.query<{ id: string; added_at: Date }>(
      `insert into ref.account_passkey (account_id, credential_id, public_key, counter, transports, label)
       values ($1::uuid, $2, $3, $4, $5, $6) returning id, added_at`,
      [accountId, credential.id, Buffer.from(credential.publicKey), credential.counter, transports, label],
    );
    return { id: rows[0]!.id, label, addedAt: rows[0]!.added_at.toISOString(), lastUsedAt: null };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new AuthError(409, "That passkey is already enrolled, on this account or another.");
    }
    throw err;
  }
}

/**
 * The second step of a sign-in, for an account that holds a passkey. Null for
 * one that holds none: its password is the whole of its sign-in.
 */
export async function beginSignIn(
  tx: PoolClient,
  accountId: string,
  userAgent: string | null,
  rp: WebAuthnRelyingParty,
) {
  const rows = await activeRows(tx, accountId);
  if (rows.length === 0) return null;
  const challenge = newChallenge();
  const { rows: made } = await tx.query<{ id: string }>(
    `insert into ref.account_challenge (purpose, account_id, challenge, user_agent, expires_at)
     values ('signin', $1::uuid, $2, $3, now() + make_interval(mins => $4)) returning id`,
    [accountId, challenge, userAgent?.slice(0, 300) ?? null, CHALLENGE_MINUTES],
  );
  return {
    signInId: made[0]!.id,
    options: {
      challenge,
      rpId: rp.rpId,
      timeout: 60_000,
      userVerification: "required" as const,
      allowCredentials: descriptors(rows),
    },
  };
}

/**
 * Check the assertion that answers a sign-in challenge. Returns the account it
 * was issued to, or throws. Every failure reads the same to the caller: which
 * part did not hold is in the ledger's log, not in the answer.
 */
export async function finishSignIn(
  tx: PoolClient,
  signInId: string,
  response: z.infer<typeof AssertionResponse>,
  rp: WebAuthnRelyingParty,
): Promise<{ accountId: string } | { refused: string }> {
  const taken = await takeChallenge(tx, signInId, "signin", null);
  if (!taken) return { refused: "the challenge is unknown, spent or expired" };

  const row = (await activeRows(tx, taken.accountId)).find((r) => r.credential_id === response.id);
  if (!row) return { refused: "the credential is not one of this account's passkeys" };

  const stored: StoredCredential = {
    id: row.credential_id,
    publicKeyB64: row.public_key.toString("base64url"),
    counter: Number(row.counter),
    ...(row.transports?.length ? { transports: row.transports } : {}),
  };
  try {
    const counter = await verifyAssertion(response, stored, taken.challenge, rp);
    await tx.query("update ref.account_passkey set counter = $2, last_used_at = now() where id = $1::uuid", [
      row.id,
      counter,
    ]);
    return { accountId: taken.accountId };
  } catch (err) {
    return { refused: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

/** Remove every passkey an account holds. Its password then signs it in alone. */
export async function removePasskeys(tx: PoolClient, accountId: string, byAccountId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `update ref.account_passkey set removed_at = now(), removed_by = $2::uuid
      where account_id = $1::uuid and removed_at is null`,
    [accountId, byAccountId],
  );
  return rowCount ?? 0;
}
