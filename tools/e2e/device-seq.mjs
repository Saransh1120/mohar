#!/usr/bin/env node
/** Real signed appends and gap alerts in a transaction that is always rolled back. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const { Client } = require("pg");
const at = (path) => new URL(`../../${path}`, import.meta.url).href;
const { appendEvent } = await import(at("services/ledger/dist/append.js"));
const { generateKeypair, signBody } = await import(at("packages/crypto-core/dist/index.js"));

const url = process.env.E2E_OWNER_URL;
if (!url) {
  console.error("Set E2E_OWNER_URL to a schema-owner database URL.");
  process.exit(2);
}
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new Client({ connectionString: url, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
let passed = 0;
const check = (message, condition) => {
  assert.ok(condition, message);
  console.log(`ok ${++passed} - ${message}`);
};

await client.query("begin");
try {
  // The test can run before the migrator deploys 012; the column exists only
  // inside this rolled-back transaction in that case.
  await client.query("alter table led.event add column if not exists device_seq bigint");
  const tag = randomBytes(3).toString("hex");
  const key = generateKeypair();
  const [auth] = (await client.query(
    "insert into ref.authority (name) values ($1) returning id", [`seq e2e ${tag}`],
  )).rows;
  const [exam] = (await client.query(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted',now() + interval '1 day',21000000,4) returning id`,
    [auth.id, `Sequence ${tag}`],
  )).rows;
  const [device] = (await client.query(
    "insert into ref.device (kind, pubkey) values ('monitor',$1) returning id",
    [Buffer.from(key.publicKeyHex, "hex")],
  )).rows;

  const submit = async (deviceSeq) => {
    const body = {
      v: 1, id: randomUUID(), examId: exam.id, kind: "MONITOR_HEARTBEAT",
      actorDeviceId: device.id, occurredAt: new Date().toISOString(), deviceSeq,
      payload: { monitorId: device.id, sequence: deviceSeq, bufferedRecords: 0 },
    };
    const signed = { body, deviceSig: signBody(body, key.privateKeyHex) };
    return { signed, result: await appendEvent(client, signed) };
  };

  const one = await submit(1);
  check("first signed event appends without a gap", one.result.status === "appended");
  const three = await submit(3);
  check("skipped sequence still appends to the chain", three.result.status === "appended");
  const [alert] = (await client.query(
    `select kind, device_id, evidence from led.alert
      where device_id = $1 and kind = 'DEVICE_SEQ_GAP'`, [device.id],
  )).rows;
  check("gap alert names the missing number", alert?.evidence?.lastSeenSeq === 1 &&
    alert?.evidence?.receivedSeq === 3 && alert?.evidence?.missingCount === 1);
  const [event] = (await client.query(
    "select device_seq from led.event where id = $1", [three.signed.body.id],
  )).rows;
  check("signed sequence is recorded with the event", Number(event?.device_seq) === 3);
  const duplicate = await appendEvent(client, three.signed);
  check("offline retry stays idempotent", duplicate.status === "duplicate");
  const [{ count }] = (await client.query(
    "select count(*)::int as count from led.alert where device_id = $1 and kind = 'DEVICE_SEQ_GAP'",
    [device.id],
  )).rows;
  check("retry does not raise a second gap alert", count === 1);
  const late = await submit(2);
  check("late arrival is recorded with a regression flag", late.result.status === "appended" &&
    late.result.flags.some((flag) => flag.code === "device_seq_regression"));
} finally {
  await client.query("rollback");
  await client.end();
}
console.log(`${passed}/${passed} device sequence checks passed; transaction rolled back`);
