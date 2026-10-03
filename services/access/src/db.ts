import { Pool, type PoolClient } from "pg";

export function createPool(connectionString: string): Pool {
  const host = new URL(connectionString).hostname;
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    ...(host === "localhost" || host === "127.0.0.1" ? {} : { ssl: { rejectUnauthorized: false } }),
  });
}

export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const result = await fn(tx);
    await tx.query("commit");
    return result;
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
