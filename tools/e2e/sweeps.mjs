#!/usr/bin/env node
/**
 * The watchdog's unopened-packet sweep and the notifier, against a real
 * Postgres, leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/sweeps.mjs
 *
 * Unlike transfer.mjs this is safe to point at a database you care about.
 * Everything it writes - an exam, three packets, the alerts raised for them,
 * the delivery attempts - happens inside one transaction that is rolled back
 * at the end. led.* cannot be cleaned up after the fact, so the test never
 * commits in the first place.
 *
 * The sweep and the notifier are the built ones from services/ledger/dist, not
 * copies. They ask a pool for a connection and run their own begin/commit; the
 * pool handed to them here always returns the one connection holding the outer
 * transaction, with begin and commit turned into a savepoint and its release.
 * The SQL they run is exactly what the ledger runs.
 *
 * Needs every migration applied, through 008. Build first (`pnpm build`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pg = createRequire(join(root, "services", "ledger", "package.json"))("pg");
const dist = (f) => new URL(`../../services/ledger/dist/domain/${f}`, import.meta.url).href;
const { sweepUnopenedPackets, sweepOverdueLegs, PACKET_UNOPENED_OVERDUE } = await import(dist("watchdog.js"));
const { deliverPending, MAX_ATTEMPTS } = await import(
  new URL("../../services/notify/dist/exports.js", import.meta.url).href
);

const ownerUrl = process.env.E2E_OWNER_URL;
if (!ownerUrl) {
  console.error("Set E2E_OWNER_URL to the schema owner's connection string.");
  process.exit(2);
}
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(ownerUrl);
const client = new pg.Client({
  connectionString: ownerUrl,
  ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
});
await client.connect();

/** A pool of exactly one connection: the one holding the outer transaction. */
const pool = {
  connect: async () => ({
    query: (text, params) => {
      const t = typeof text === "string" ? text.trim().toLowerCase() : "";
      if (t === "begin") return client.query("savepoint sweep");
      if (t === "commit") return client.query("release savepoint sweep");
      if (t === "rollback") return client.query("rollback to savepoint sweep");
      return client.query(text, params);
    },
    release: () => {},
  }),
};

const q = (t, p) => client.query(t, p).then((r) => r.rows);
const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });

await client.query("begin");
try {
  // "Now" is taken a year ahead so nothing already in this database is inside
  // the sweep's look-back window: the only packets it can find are these.
  const NOW = new Date(Date.now() + 365 * 86400_000);
  const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
  const tag = randomBytes(3).toString("hex");

  const [auth] = await q(
    `insert into ref.authority (name) values ($1) returning id`, [`sweeps e2e ${tag}`]);
  const exam = async (name, startsAt) =>
    (await q(
      `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
       values ($1,$2,'escorted',$3,21000000,4) returning id`, [auth.id, name, startsAt]))[0].id;
  const packet = async (examId, code, serial) => {
    const [centre] = await q(
      `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,26.9,75.7,300) returning id`,
      [examId, code]);
    const [pkg] = await q(
      `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
      [examId, centre.id, serial]);
    return { id: pkg.id, centreId: centre.id, examId };
  };

  // Starts in 5 minutes: due to open 10 minutes ago, nothing on the chain.
  const dueExam = await exam(`Physics ${tag}`, at(5));
  const unopened = await packet(dueExam, `SW-A-${tag}`, `PKT-SW-${tag}-A`);
  // Same exam, but the chain holds an opening.
  const opened = await packet(dueExam, `SW-B-${tag}`, `PKT-SW-${tag}-B`);
  // Same exam, nothing on the chain, but the access engine granted its unlock.
  const granted = await packet(dueExam, `SW-E-${tag}`, `PKT-SW-${tag}-E`);
  // Starts in 40 minutes: not due to open for another 25.
  const laterExam = await exam(`Chemistry ${tag}`, at(40));
  const notYet = await packet(laterExam, `SW-C-${tag}`, `PKT-SW-${tag}-C`);
  // Opening time passed three days ago: outside the look-back window.
  const oldExam = await exam(`History ${tag}`, at(-3 * 24 * 60));
  const old = await packet(oldExam, `SW-D-${tag}`, `PKT-SW-${tag}-D`);

  // An opening on the chain for the second packet. The row is written straight
  // into led.event because the sweep only reads `package_id` and `kind`; this
  // is the owner's connection and the row never commits.
  const [device] = await q(
    `insert into ref.device (kind, pubkey) values ('centre_pc',$1) returning id`, [randomBytes(32)]);
  const zero = Buffer.alloc(32);
  await q(
    `insert into led.event (id, exam_id, package_id, centre_id, kind, occurred_at, received_at,
                            clock_skew_ms, actor_device, body, device_sig, body_hash, prev_hash, hash)
     values ($1,$2,$3,$4,'PACKET_OPENED',$5,$5,0,$6,'{}'::jsonb,$7,$8,$9,$10)`,
    [randomUUID(), dueExam, opened.id, opened.centreId, at(-12), device.id,
      Buffer.alloc(64), zero, randomBytes(32), randomBytes(32)]);

  await q(
    `insert into led.access_attempt
       (package_id, centre_id, exam_id, stage, current_epoch, outcome, attempted_at)
     values ($1,$2,$3,'unlock',1,'granted', now())`,
    [granted.id, granted.centreId, dueExam]);

  // ── the sweep ──
  const raised = await sweepUnopenedPackets(pool, NOW);
  const ids = raised.map((r) => r.packageId);
  expect("the packet past its opening time with nothing on the chain is raised",
    ids.includes(unopened.id), JSON.stringify(raised));
  expect("a packet with an opening on the chain is not raised", !ids.includes(opened.id));
  expect("a packet whose unlock the access engine granted is not raised", !ids.includes(granted.id));
  expect("a packet not yet due to open is not raised", !ids.includes(notYet.id));
  expect("a packet whose opening time passed days ago is not raised", !ids.includes(old.id));
  expect("nothing else in this database was raised", raised.length === 1, `${raised.length} raised`);

  const [row] = await q(
    `select kind, centre_id, requires_decision, evidence, consequence from led.alert where package_id = $1`,
    [unopened.id]);
  expect("the alert is a PACKET_UNOPENED_OVERDUE row that requires a decision",
    row?.kind === PACKET_UNOPENED_OVERDUE && row.requires_decision === true && row.centre_id === unopened.centreId);
  expect("it records how late: ten minutes, in seconds",
    row?.evidence.overdueBySeconds === 600, String(row?.evidence.overdueBySeconds));
  const [unopenedEvent] = await q(
    `select e.body, d.kind as device_kind from led.event e join ref.device d on d.id = e.actor_device
      where e.package_id = $1 and e.kind = 'PACKET_UNOPENED_OVERDUE'`, [unopened.id]);
  expect("the same finding is on the chain, signed by the ledger's service device",
    unopenedEvent?.device_kind === "service" && unopenedEvent.body.payload.overdueBySeconds === 600 &&
    unopenedEvent.body.payload.scheduledOpenAt === row?.evidence.scheduledOpenAt);
  expect("it records the scheduled opening time",
    row?.evidence.scheduledOpenAt === at(-10).toISOString(), row?.evidence.scheduledOpenAt);
  expect("it carries a consequence", typeof row?.consequence === "string" && row.consequence.length > 40);

  const again = await sweepUnopenedPackets(pool, new Date(NOW.getTime() + 60_000));
  expect("a packet that stays unopened is raised once, not on every sweep",
    again.length === 0, `${again.length} raised on the second sweep`);

  // The leg sweep is not disturbed by any of this: there are no legs here.
  const legs = await sweepOverdueLegs(pool, new Date(0));
  expect("the leg sweep still runs beside it", Array.isArray(legs));

  // ── the notifier ──
  // An alert's raised_at is the database's own clock, not the sweep's "now",
  // so delivery is measured from the real time.
  const TODAY = new Date();
  // The database this runs against may hold real alerts raised in the last day.
  // The notifier offers those to these channels too, inside the transaction, so
  // the stand-ins only count and only fail the alert this test raised.
  const ours = (n) => n.text.includes(`PKT-SW-${tag}-A`);
  const sent = [];
  let failNext = 2;
  const good = { name: "e2e-good", send: async (n) => { if (ours(n)) sent.push(n); } };
  const flaky = {
    name: "e2e-flaky",
    send: async (n) => {
      if (ours(n) && failNext > 0) { failNext -= 1; throw new Error("far end refused"); }
    },
  };
  const dead = { name: "e2e-dead", send: async () => { throw new Error("no route"); } };
  const mine = (ds) => ds.filter((d) => d.alertId === raised[0]?.alertId);

  const first = mine(await deliverPending(pool, [good, flaky], TODAY));
  expect("a new alert is sent on every channel",
    first.length === 2 && first.find((d) => d.channel === "e2e-good")?.outcome === "sent");
  expect("the message names the packet and carries the consequence",
    sent.length === 1 && sent[0].text.includes(`PKT-SW-${tag}-A`) && sent[0].text.includes(row.consequence),
    sent[0]?.text);
  expect("a send the far end refuses is recorded as failed, with what it said",
    first.find((d) => d.channel === "e2e-flaky")?.detail === "far end refused");

  const second = mine(await deliverPending(pool, [good, flaky], TODAY));
  expect("an alert already sent on a channel is not sent on it again",
    !second.some((d) => d.channel === "e2e-good") && sent.length === 1);
  const third = mine(await deliverPending(pool, [good, flaky], TODAY));
  expect("a failed channel is retried until it gets through",
    second.find((d) => d.channel === "e2e-flaky")?.outcome === "failed" &&
    third.find((d) => d.channel === "e2e-flaky")?.outcome === "sent");

  const attempts = await q(
    `select outcome from led.alert_delivery where alert_id = $1 and channel = 'e2e-flaky' order by attempted_at, id`,
    [raised[0].alertId]);
  expect("every attempt is its own row: two failures and then the send",
    attempts.filter((a) => a.outcome === "failed").length === 2 &&
    attempts.filter((a) => a.outcome === "sent").length === 1,
    attempts.map((a) => a.outcome).join(","));

  let deadRounds = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    if (mine(await deliverPending(pool, [dead], TODAY)).length > 0) deadRounds += 1;
  }
  expect(`a channel that never gets through stops after ${MAX_ATTEMPTS} attempts`,
    deadRounds === MAX_ATTEMPTS, `${deadRounds} attempts`);

  const stale = mine(await deliverPending(pool, [{ name: "e2e-late", send: async () => {} }],
    new Date(TODAY.getTime() + 25 * 3600_000)));
  expect("an alert a day old is not announced by a channel configured later", stale.length === 0);
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.authority where name like 'sweeps e2e %'`)
    .then((r) => r.rows[0].n)
    .catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await client.end();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n        ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
