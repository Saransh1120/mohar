import { Pool } from "pg";

/**
 * The application connects as `mohar_app`, which holds INSERT and SELECT on
 * led.event and no UPDATE or DELETE. That is not a convention this code
 * enforces — it is a grant in 001_init.sql. Connecting as a superuser in
 * production would silently discard the system's central guarantee, so the
 * startup check below refuses to run if the role can mutate the ledger.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export class LedgerPrivilegeError extends Error {
  override readonly name = "LedgerPrivilegeError";
}

/** Fail fast if this connection could rewrite history. */
export async function assertAppendOnly(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ priv: string }>(
    `select privilege_type as priv
       from information_schema.table_privileges
      where table_schema = 'led'
        and table_name   = 'event'
        and grantee      = current_user
        and privilege_type in ('UPDATE', 'DELETE')`,
  );
  if (rows.length > 0) {
    throw new LedgerPrivilegeError(
      `connected role holds ${rows.map((r) => r.priv).join(" and ")} on led.event. ` +
        "The append-only guarantee depends on this grant being absent. " +
        "Connect as mohar_app, not as the migration owner or a superuser.",
    );
  }

  const su = await pool.query<{ usesuper: boolean }>(
    "select usesuper from pg_user where usename = current_user",
  );
  if (su.rows[0]?.usesuper) {
    throw new LedgerPrivilegeError(
      "connected as a superuser: table privileges and the append-only triggers " +
        "are both bypassable. Connect as mohar_app.",
    );
  }
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
