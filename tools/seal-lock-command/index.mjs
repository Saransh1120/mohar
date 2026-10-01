#!/usr/bin/env node
/** Sign one short-lived UART command for a recent, granted unlock attempt. */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import pg from "pg";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const attemptId = args.get("--attempt");
const seedHex = process.env.SEAL_LOCK_AUTHORITY_SEED_HEX;
const expectedPub = process.env.SEAL_LOCK_AUTHORITY_PUBLIC_KEY_HEX;
const databaseUrl = process.env.DATABASE_URL;

if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId ?? "") ||
    !/^[0-9a-f]{64}$/i.test(seedHex ?? "") ||
    !/^[0-9a-f]{64}$/i.test(expectedPub ?? "") || !databaseUrl) {
  console.error("Set DATABASE_URL, SEAL_LOCK_AUTHORITY_SEED_HEX and SEAL_LOCK_AUTHORITY_PUBLIC_KEY_HEX; pass --attempt <granted-access-attempt-uuid>.");
  process.exit(1);
}

const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]),
  format: "der",
  type: "pkcs8",
});
const actualPub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
if (actualPub !== expectedPub.toLowerCase()) throw new Error("authority private key does not match the board's pinned public key");

const host = new URL(databaseUrl).hostname;
const db = new pg.Client({
  connectionString: databaseUrl,
  ...(host === "localhost" || host === "127.0.0.1" ? {} : { ssl: { rejectUnauthorized: false } }),
});

try {
  await db.connect();
  await db.query("begin");
  const { rows: attempts } = await db.query(
    `select id, package_id from led.access_attempt
      where id = $1::uuid and outcome = 'granted' and stage = 'unlock'
        and decided_at between now() - interval '60 seconds' and now() + interval '5 seconds'`,
    [attemptId],
  );
  const attempt = attempts[0];
  if (!attempt?.package_id) throw new Error("no recent granted unlock attempt with this ID");

  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`seal-lock:${attempt.package_id}`]);
  const { rows } = await db.query(
    `select coalesce(max(command_counter), 0)::text as last_counter
       from led.seal_lock_command where package_id = $1::uuid`,
    [attempt.package_id],
  );
  const counter = Number(rows[0].last_counter) + 1;
  if (!Number.isSafeInteger(counter) || counter > 0xffffffff) throw new Error("seal-lock command counter exhausted");
  const { rows: times } = await db.query("select floor(extract(epoch from now() + interval '30 seconds'))::bigint as expiry");
  const expiry = String(times[0].expiry);
  await db.query(
    `insert into led.seal_lock_command (attempt_id, package_id, command_counter, expires_at)
     values ($1::uuid, $2::uuid, $3, to_timestamp($4::bigint))`,
    [attempt.id, attempt.package_id, counter, expiry],
  );
  await db.query("commit");

  const message = `MOHAR-SEAL-LOCK-v1|${attempt.package_id}|${attempt.id}|${counter}|${expiry}`;
  const signature = sign(null, Buffer.from(message, "ascii"), key).toString("hex");
  process.stdout.write(`OPEN|${attempt.id}|${counter}|${expiry}|${signature}\n`);
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
