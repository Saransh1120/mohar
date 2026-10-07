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
  /** The centres this account is limited to by name. See http/scope-guard. */
  centreIds: string[];
  /** The districts it is limited to: whichever centres are in them when it asks. */
  districts: string[];
  /**
   * Whether the account has a limit at all. Not the same as "it can see some
   * centre": an account limited to a district that has lost its last centre is
   * still limited, and sees nothing.
   */
  limited: boolean;
}

/** What an account is limited to. Both empty is no limit. */
export interface AccountLimit {
  centreIds: string[];
  districts: string[];
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
    // Filled in by whoever loads the account for a request; see limitOf.
    centreIds: [],
    districts: [],
    limited: false,
  };
}

const NO_TABLE = "42P01";

/**
 * What an account is limited to.
 *
 * Before migrations 017 and 018 the tables are not there. Then nobody can have
 * been limited, so the answer is "no limit" and not an error: a deployment
 * that has not run them must still be able to sign in.
 */
export async function limitOf(db: Pool | PoolClient, accountId: string): Promise<AccountLimit> {
  const read = async (sql: string): Promise<string[]> => {
    try {
      const { rows } = await db.query<{ v: string }>(sql, [accountId]);
      return rows.map((r) => r.v);
    } catch (err) {
      if ((err as { code?: string }).code === NO_TABLE) return [];
      throw err;
    }
  };
  return {
    centreIds: await read(
      "select centre_id as v from ref.account_centre where account_id = $1::uuid order by centre_id",
    ),
    districts: await read(
      "select district as v from ref.account_district where account_id = $1::uuid order by lower(district)",
    ),
  };
}

export function withLimit(account: Account, limit: AccountLimit): Account {
  return {
    ...account,
    centreIds: limit.centreIds,
    districts: limit.districts,
    limited: limit.centreIds.length > 0 || limit.districts.length > 0,
  };
}

/**
 * The centres a limit comes to, now: the ones named, and whichever are in the
 * districts named. Asked on each request, so a centre moved into a district is
 * seen at once and one moved out is not seen again.
 */
export async function centresInLimit(db: Pool | PoolClient, limit: AccountLimit): Promise<string[]> {
  if (limit.districts.length === 0) return limit.centreIds;
  const { rows } = await db.query<{ id: string }>(
    `select id from ref.centre
      where id = any($1::uuid[]) or lower(district) = any($2::text[])
      order by id`,
    [limit.centreIds, limit.districts.map((d) => d.toLowerCase())],
  );
  return rows.map((r) => r.id);
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

/**
 * Check a username and password, and nothing more: no session is opened.
 *
 * Apart from `signIn` so that an account holding a passkey can have its
 * password checked first and its session opened only after the passkey has
 * answered (domain/passkeys).
 */
export async function checkPassword(tx: PoolClient, username: string, password: string): Promise<Account> {
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
  return toAccount(row);
}

/** Open a session for an account whose credentials have already been checked. */
export async function openSession(
  tx: PoolClient,
  accountId: string,
  userAgent: string | null,
): Promise<SignedInSession> {
  const { rows } = await tx.query<AccountRow>("select * from ref.account where id = $1::uuid", [accountId]);
  const row = rows[0];
  // Disabled between the password and the passkey: the second step does not get in.
  if (!row || row.disabled_at) throw new AuthError(403, "This account is disabled.");

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

/** A password sign-in in one step, for an account that holds no passkey. */
export async function signIn(
  tx: PoolClient,
  username: string,
  password: string,
  userAgent: string | null,
): Promise<SignedInSession> {
  const account = await checkPassword(tx, username, password);
  return openSession(tx, account.id, userAgent);
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
  return withLimit(toAccount(row), await limitOf(pool, row.id));
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
export async function accountCount(db: Pool | PoolClient): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*)::text as n from ref.account");
  return Number(rows[0]?.n ?? 0);
}

export interface ListedAccount extends Account {
  disabledAt: string | null;
  disabledReason: string | null;
}

/** Every account, disabled ones included. Never the password material. */
export async function listAccounts(pool: Pool): Promise<ListedAccount[]> {
  const { rows } = await pool.query<AccountRow>(
    `select id, username, display_name, role, person_id, created_at, last_sign_in,
            disabled_at, disabled_reason
       from ref.account
      order by created_at`,
  );
  const out: ListedAccount[] = [];
  for (const r of rows) {
    out.push({
      ...withLimit(toAccount(r), await limitOf(pool, r.id)),
      disabledAt: r.disabled_at ? r.disabled_at.toISOString() : null,
      disabledReason: r.disabled_reason,
    });
  }
  return out;
}

/** A district's name as it is kept: trimmed, single spaces. Compared without case. */
export function districtName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Limit an account to the centres and districts named, or lift the limit with
 * both lists empty.
 *
 * What is given replaces what was there. The last control room operator with
 * no limit cannot be given one: a limited account changes nothing, so with all
 * of them limited there would be nobody left who could lift a limit.
 */
export async function setAccountLimit(
  tx: PoolClient,
  accountId: string,
  limit: { centreIds: readonly string[]; districts: readonly string[] },
  byAccountId: string,
): Promise<{ before: AccountLimit; after: AccountLimit; username: string }> {
  const { rows } = await tx.query<{ username: string; role: string; disabled_at: Date | null }>(
    "select username, role, disabled_at from ref.account where id = $1::uuid for update",
    [accountId],
  );
  const target = rows[0];
  if (!target) throw new AuthError(404, "No such account.");

  const centres = [...new Set(limit.centreIds)].sort();
  if (centres.length > 0) {
    const { rows: known } = await tx.query<{ id: string }>(
      "select id from ref.centre where id = any($1::uuid[])",
      [centres],
    );
    if (known.length !== centres.length) throw new AuthError(400, "One of those centres does not exist.");
  }

  // One row per district however it was capitalised, spelled as a centre has it.
  const districts: string[] = [];
  for (const raw of limit.districts) {
    const name = districtName(raw);
    if (name.length < 2 || name.length > 80) throw new AuthError(400, "A district's name is 2 to 80 characters.");
    const { rows: has } = await tx.query<{ district: string }>(
      "select district from ref.centre where lower(district) = lower($1) order by district limit 1",
      [name],
    );
    // A limit to a district nobody is in would show the account nothing, and
    // is far more likely a misspelling than an intention.
    if (!has[0]) throw new AuthError(400, `No centre is in a district called "${name}".`);
    if (!districts.some((d) => d.toLowerCase() === name.toLowerCase())) districts.push(has[0].district);
  }
  districts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  if ((centres.length > 0 || districts.length > 0) && target.role === "control_room" && !target.disabled_at) {
    const { rows: free } = await tx.query<{ n: string }>(
      `select count(*)::text as n from ref.account a
        where a.role = 'control_room' and a.disabled_at is null and a.id <> $1::uuid
          and not exists (select 1 from ref.account_centre c where c.account_id = a.id)
          and not exists (select 1 from ref.account_district d where d.account_id = a.id)`,
      [accountId],
    );
    if (Number(free[0]?.n ?? 0) === 0) {
      throw new AuthError(
        409,
        "This is the last control room operator with no limit. Limited, nobody could lift a limit again.",
      );
    }
  }

  const before = await limitOf(tx, accountId);
  await tx.query("delete from ref.account_centre where account_id = $1::uuid", [accountId]);
  await tx.query("delete from ref.account_district where account_id = $1::uuid", [accountId]);
  for (const centreId of centres) {
    await tx.query(
      "insert into ref.account_centre (account_id, centre_id, granted_by) values ($1::uuid, $2::uuid, $3::uuid)",
      [accountId, centreId, byAccountId],
    );
  }
  for (const district of districts) {
    await tx.query(
      "insert into ref.account_district (account_id, district, granted_by) values ($1::uuid, $2, $3::uuid)",
      [accountId, district, byAccountId],
    );
  }
  return { before, after: { centreIds: centres, districts }, username: target.username };
}

/**
 * Disable an account and end its sessions.
 *
 * Disabled, not deleted: an acknowledgement or an override decision made by
 * this account last week still has to name who made it.
 *
 * The last control room operator cannot be disabled. With sign-up closed, a
 * system with no operator has nobody who can create one.
 */
export async function disableAccount(tx: PoolClient, id: string, reason: string): Promise<void> {
  const { rows } = await tx.query<{ role: string; disabled_at: Date | null }>(
    "select role, disabled_at from ref.account where id = $1::uuid for update",
    [id],
  );
  const target = rows[0];
  if (!target) throw new AuthError(404, "No such account.");
  if (target.disabled_at) throw new AuthError(409, "That account is already disabled.");

  if (target.role === "control_room") {
    const { rows: others } = await tx.query<{ n: number }>(
      `select count(*)::int as n from ref.account
        where role = 'control_room' and disabled_at is null and id <> $1::uuid`,
      [id],
    );
    if ((others[0]?.n ?? 0) === 0) {
      throw new AuthError(
        409,
        "This is the only control room operator. Create another before disabling this one.",
      );
    }
  }

  await tx.query(
    "update ref.account set disabled_at = now(), disabled_reason = $2 where id = $1::uuid",
    [id, reason],
  );
  await tx.query(
    "update ref.session set revoked_at = now() where account_id = $1::uuid and revoked_at is null",
    [id],
  );
}
