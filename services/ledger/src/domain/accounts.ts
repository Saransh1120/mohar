/**
 * Operator accounts: registration, sign-in, sessions.
 *
 * Two rules shape everything here.
 *
 * 1. The password never exists at rest. We store scrypt(password, salt) with the
 *    cost parameters alongside it, and compare with a timing-safe equality. A
 *    database dump yields nothing that can be replayed against this endpoint.
 *
 * 2. A failed sign-in must not say which half was wrong. "No such user" and
 *    "wrong password" together are a username oracle, so both return the same
 *    message and both pay the same scrypt cost — an unknown username is
 *    verified against a throwaway salt so the response time does not leak
 *    either.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  type ScryptOptions,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";

// Hand-written rather than promisify()'d: promisify picks the three-argument
// overload of scrypt and there is no way to reach the options argument through
// it, and the options argument is where the cost parameters live.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Cost for new passwords. Stored per row, so raising this is not a break. */
const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** How long a browser session lasts before it must be re-established. */
export const SESSION_TTL_HOURS = 12;

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: string;
  personId: string | null;
  createdAt: string;
  lastSignIn: string | null;
}

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  role: string;
  person_id: string | null;
  created_at: Date;
  last_sign_in: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  password_hash: Buffer;
  password_salt: Buffer;
  scrypt_n: number;
  scrypt_r: number;
  scrypt_p: number;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    personId: r.person_id,
    createdAt: r.created_at.toISOString(),
    lastSignIn: r.last_sign_in ? r.last_sign_in.toISOString() : null,
  };
}

async function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  // scrypt's default maxmem (32 MB) sits below what N=16384, r=8 needs, so it is
  // raised explicitly. Without this the call throws rather than running slower.
  return scrypt(password, salt, KEYLEN, {
    N: n,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
}

/**
 * Rules a password must satisfy. Deliberately short: length carries far more
 * entropy than a character-class checklist, and complexity rules mostly produce
 * P@ssw0rd1. Twelve characters is the floor because this account can read the
 * whole custody record for an examination.
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 200) return "Password must be at most 200 characters.";
  if (/^\s|\s$/.test(password)) return "Password must not start or end with a space.";
  return null;
}

export function checkUsername(username: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(username)) {
    return "Username must be 3-64 characters: letters, digits, dot, dash or underscore.";
  }
  return null;
}

const ROLES = new Set([
  "superintendent",
  "observer",
  "custodian",
  "courier",
  "district_officer",
  "control_room",
]);

export const ACCOUNT_ROLES = [...ROLES];

export interface SignUpInput {
  username: string;
  password: string;
  displayName: string;
  role?: string;
}

export async function createAccount(tx: PoolClient, input: SignUpInput): Promise<Account> {
  const username = String(input.username ?? "").trim();
  const displayName = String(input.displayName ?? "").trim();
  const password = String(input.password ?? "");

  const badName = checkUsername(username);
  if (badName) throw new AuthError(400, badName);
  const badPass = checkPasswordStrength(password);
  if (badPass) throw new AuthError(400, badPass);
  if (displayName.length < 2 || displayName.length > 120) {
    throw new AuthError(400, "Display name must be between 2 and 120 characters.");
  }

  const role = input.role ?? "control_room";
  if (!ROLES.has(role)) throw new AuthError(400, `Unknown role "${role}".`);

  const salt = randomBytes(16);
  const hash = await derive(password, salt);

  try {
    const { rows } = await tx.query<AccountRow>(
      `insert into ref.account
         (username, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p,
          role, display_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [username, hash, salt, N, R, P, role, displayName],
    );
    return toAccount(rows[0]!);
  } catch (err) {
    // 23505 — the case-insensitive unique index on the username.
    if ((err as { code?: string }).code === "23505") {
      throw new AuthError(409, "That username is already taken.");
    }
    throw err;
  }
}

/** Salt used when the username does not exist, so both paths cost the same. */
const DUMMY_SALT = randomBytes(16);

export interface SignedInSession {
  token: string;
  expiresAt: string;
  account: Account;
}

export async function signIn(
  tx: PoolClient,
  username: string,
  password: string,
  userAgent: string | null,
): Promise<SignedInSession> {
  const { rows } = await tx.query<AccountRow>(
    "select * from ref.account where lower(username) = lower($1)",
    [String(username ?? "").trim()],
  );
  const row = rows[0];

  if (!row) {
    // Pay the same cost as a real verification before refusing.
    await derive(String(password ?? ""), DUMMY_SALT);
    throw new AuthError(401, "Incorrect username or password.");
  }

  const attempt = await derive(
    String(password ?? ""),
    row.password_salt,
    row.scrypt_n,
    row.scrypt_r,
    row.scrypt_p,
  );
  if (attempt.length !== row.password_hash.length || !timingSafeEqual(attempt, row.password_hash)) {
    throw new AuthError(401, "Incorrect username or password.");
  }

  if (row.disabled_at) {
    throw new AuthError(
      403,
      row.disabled_reason
        ? `This account is disabled: ${row.disabled_reason}`
        : "This account is disabled.",
    );
  }

  // The password was right, so this is the moment to re-hash it under the
  // current cost if the row was written under an older, cheaper one.
  if (row.scrypt_n !== N || row.scrypt_r !== R || row.scrypt_p !== P) {
    const salt = randomBytes(16);
    const rehashed = await derive(password, salt);
    await tx.query(
      `update ref.account
          set password_hash = $2, password_salt = $3,
              scrypt_n = $4, scrypt_r = $5, scrypt_p = $6
        where id = $1`,
      [row.id, rehashed, salt, N, R, P],
    );
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);

  await tx.query(
    `insert into ref.session (token_hash, account_id, expires_at, user_agent)
     values ($1, $2, $3, $4)`,
    [tokenHash, row.id, expiresAt, userAgent?.slice(0, 300) ?? null],
  );
  await tx.query("update ref.account set last_sign_in = now() where id = $1", [row.id]);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    account: { ...toAccount(row), lastSignIn: new Date().toISOString() },
  };
}

/**
 * Resolve a bearer token to its account, or null.
 *
 * Expiry is arithmetic on the clock rather than a cleanup job, for the same
 * reason the custody keys are: if the sweeper never runs, sessions must stop
 * working, not keep working.
 */
export async function accountForToken(pool: Pool, token: string | null): Promise<Account | null> {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest();

  const { rows } = await pool.query<AccountRow>(
    `select a.*
       from ref.session s
       join ref.account a on a.id = s.account_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and a.disabled_at is null`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;

  await pool.query("update ref.session set last_seen_at = now() where token_hash = $1", [tokenHash]);
  return toAccount(row);
}

export async function signOut(pool: Pool, token: string | null): Promise<void> {
  if (!token) return;
  const tokenHash = createHash("sha256").update(token).digest();
  await pool.query(
    "update ref.session set revoked_at = now() where token_hash = $1 and revoked_at is null",
    [tokenHash],
  );
}

/** How many accounts exist. Zero means the next sign-up claims the system. */
export async function accountCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("select count(*)::text as n from ref.account");
  return Number(rows[0]?.n ?? 0);
}
