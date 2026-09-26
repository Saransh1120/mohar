import type { Pool, PoolClient } from "pg";

/**
 * ── The Delayed Transfer Alert ───────────────────────────────────────────────
 *
 * Every leg is planned with an `expected_by`. A leg that passes it with no
 * completed hand-off raises LEG_OVERDUE, once, into led.alert.
 *
 * This is the half of the hand-off engine that answers to silence. A refused
 * hand-off is loud: somebody tried and the attempt is on record. A packet that
 * never arrives produces no attempt at all, and without something watching the
 * clock the record would simply stay quiet about it. "Silence is an alarm" is
 * only true if something turns the silence into a row.
 *
 * It runs inside the ledger process until `services/watchdog` exists, because
 * the ledger is the one process that is always up when legs exist to be late.
 *
 * What the alert carries is what is known at the moment it is raised: how far
 * the leg got, how late it is, how many attempts were refused, and the last
 * person the engine verified with the packet. That last name is the point of
 * the whole alert: it is who the control room calls first.
 */

/** One alert per leg. A leg that stays late does not raise a second one. */
export const LEG_OVERDUE = "LEG_OVERDUE";

/** How far the leg got before it stopped. */
export type OverdueStage = "not_dispatched" | "dispatched" | "key_released";

export interface LastVerified {
  personId: string;
  name: string;
  role: string;
  /** The step at which the engine verified this person with the packet. */
  step: "dispatch" | "receive" | "confirm";
  legNo: number;
  at: string;
}

/** Everything the sweep reads about one late leg, before it decides anything. */
export interface OverdueLegFacts {
  legId: string;
  legNo: number;
  packageId: string;
  centreId: string | null;
  centreCode: string | null;
  packetSerial: string | null;
  fromRole: string;
  toRole: string;
  fromPlace: string;
  toPlace: string;
  expectedBy: Date;
  dispatchedAt: Date | null;
  keyReleasedAt: Date | null;
  refusedAttempts: number;
  lastVerified: LastVerified | null;
}

export interface OverdueAlert {
  evidence: Record<string, unknown>;
  consequence: string;
}

const role = (r: string) => r.replace(/_/g, " ");

function who(v: LastVerified): string {
  return `${v.name} (${role(v.role)})`;
}

/**
 * Turn the facts about one late leg into the alert's evidence and consequence.
 *
 * Pure, so it can be tested without a database. The consequence says what the
 * record now implies about where the packet is and who answers for it. It does
 * not rank the alert: a leg ten minutes late and a leg ten hours late are both
 * a packet nobody has accepted, and the control room reads the minutes itself.
 */
export function describeOverdueLeg(f: OverdueLegFacts, now: Date): OverdueAlert {
  const stage: OverdueStage = f.keyReleasedAt
    ? "key_released"
    : f.dispatchedAt
      ? "dispatched"
      : "not_dispatched";

  const overdueBySeconds = Math.max(1, Math.round((now.getTime() - f.expectedBy.getTime()) / 1000));

  const evidence: Record<string, unknown> = {
    legId: f.legId,
    legNo: f.legNo,
    fromRole: f.fromRole,
    toRole: f.toRole,
    fromPlace: f.fromPlace,
    toPlace: f.toPlace,
    expectedBy: f.expectedBy.toISOString(),
    detectedAt: now.toISOString(),
    overdueBySeconds,
    stage,
    refusedAttempts: f.refusedAttempts,
    // Optional facts are omitted rather than written as null, the same rule
    // the signed event bodies follow: absent means "not known", and a null
    // invites the reader to wonder whether it was known to be empty.
    ...(f.packetSerial ? { packetSerial: f.packetSerial } : {}),
    ...(f.centreCode ? { centreCode: f.centreCode } : {}),
    ...(f.dispatchedAt ? { dispatchedAt: f.dispatchedAt.toISOString() } : {}),
    ...(f.keyReleasedAt ? { keyReleasedAt: f.keyReleasedAt.toISOString() } : {}),
    ...(f.lastVerified ? { lastVerified: f.lastVerified } : {}),
  };

  const refusals =
    f.refusedAttempts > 0
      ? ` ${f.refusedAttempts} attempt${f.refusedAttempts === 1 ? " was" : "s were"} refused on this leg.`
      : "";

  let consequence: string;
  if (stage === "key_released") {
    const receiver = f.lastVerified ? who(f.lastVerified) : `the ${role(f.toRole)}`;
    consequence =
      `${receiver} passed every check at ${f.toPlace} and was given the transfer key, but the ` +
      `key was never submitted, so the leg is still open. The packet is attributed to ` +
      `${receiver} until the control room confirms it with them and records how the ` +
      `hand-off ends.${refusals}`;
  } else if (stage === "dispatched") {
    const sender = f.lastVerified ? who(f.lastVerified) : `the ${role(f.fromRole)}`;
    consequence =
      `${sender} dispatched this packet from ${f.fromPlace}, and nobody at ${f.toPlace} has ` +
      `accepted it. It is unaccounted for between the two places until the control room ` +
      `reaches ${sender} and the receiving ${role(f.toRole)}.${refusals}`;
  } else {
    const holder = f.lastVerified
      ? `${who(f.lastVerified)}, who was last verified with it`
      : `the ${role(f.fromRole)} at ${f.fromPlace}; no hand-off of this packet has been recorded yet`;
    consequence =
      `Nobody has dispatched this leg. The packet is treated as still with ${holder}, ` +
      `until the control room reaches them and records where it is.${refusals}`;
  }

  return { evidence, consequence };
}

interface CandidateRow {
  id: string;
  package_id: string;
  leg_no: number;
  from_role: string;
  to_role: string;
  from_place: string;
  to_place: string;
  expected_by: Date;
  seal_serial: string | null;
  centre_id: string | null;
  centre_code: string | null;
  dispatched_at: Date | null;
  key_released_at: Date | null;
  refused: number;
}

async function lastVerifiedFor(
  tx: PoolClient,
  packageId: string,
  legNo: number,
): Promise<LastVerified | null> {
  // The most recent granted step on this packet, on this leg or an earlier
  // one. A dispatch names the sender, a receive or confirm names the receiver:
  // in every case it is the last person the engine saw standing at the packet.
  const { rows } = await tx.query<{
    person_id: string;
    display_name: string;
    role: string;
    step: "dispatch" | "receive" | "confirm";
    leg_no: number;
    recorded_at: Date;
  }>(
    `select a.person_id, p.display_name, p.role, a.checks ->> 'step' as step,
            r.leg_no, a.recorded_at
       from led.transfer_attempt a
       join ref.route_leg r on r.id = a.leg_id
       join ref.person p on p.id = a.person_id
      where r.package_id = $1::uuid and r.leg_no <= $2 and a.outcome = 'granted'
      order by a.recorded_at desc
      limit 1`,
    [packageId, legNo],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    personId: r.person_id,
    name: r.display_name,
    role: r.role,
    step: r.step,
    legNo: r.leg_no,
    at: r.recorded_at.toISOString(),
  };
}

export interface RaisedOverdue {
  alertId: string;
  legId: string;
  legNo: number;
  overdueBySeconds: number;
}

/**
 * Raise LEG_OVERDUE for every leg past its expected time with no completed
 * hand-off and no LEG_OVERDUE already on record.
 *
 * One transaction under an advisory lock, so two ledger processes sweeping at
 * the same moment cannot both decide a leg has no alert yet and raise two.
 */
export async function sweepOverdueLegs(pool: Pool, now: Date = new Date()): Promise<RaisedOverdue[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('watchdog:leg_overdue'))");

    const { rows } = await client.query<CandidateRow>(
      `select r.id, r.package_id, r.leg_no, r.from_role, r.to_role, r.from_place, r.to_place,
              r.expected_by, p.seal_serial, p.centre_id, c.code as centre_code,
              (select min(a.recorded_at) from led.transfer_attempt a
                where a.leg_id = r.id and a.outcome = 'granted'
                  and a.checks ->> 'step' = 'dispatch') as dispatched_at,
              k.issued_at as key_released_at,
              (select count(*) from led.transfer_attempt a
                where a.leg_id = r.id and a.outcome = 'refused')::int as refused
         from ref.route_leg r
         join ref.package p on p.id = r.package_id
         left join ref.centre c on c.id = p.centre_id
         left join led.transfer_key k on k.leg_id = r.id
        where r.expected_by < $1
          and not exists (
            select 1 from led.transfer_attempt a
             where a.leg_id = r.id and a.outcome = 'granted'
               and a.checks ->> 'step' = 'confirm')
          and not exists (
            select 1 from led.alert x where x.leg_id = r.id and x.kind = $2)
        order by r.expected_by
        limit 500`,
      [now, LEG_OVERDUE],
    );

    const raised: RaisedOverdue[] = [];
    for (const r of rows) {
      const facts: OverdueLegFacts = {
        legId: r.id,
        legNo: r.leg_no,
        packageId: r.package_id,
        centreId: r.centre_id,
        centreCode: r.centre_code,
        packetSerial: r.seal_serial,
        fromRole: r.from_role,
        toRole: r.to_role,
        fromPlace: r.from_place,
        toPlace: r.to_place,
        expectedBy: r.expected_by,
        dispatchedAt: r.dispatched_at,
        keyReleasedAt: r.key_released_at,
        refusedAttempts: r.refused,
        lastVerified: await lastVerifiedFor(client, r.package_id, r.leg_no),
      };
      const alert = describeOverdueLeg(facts, now);
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into led.alert
           (kind, package_id, leg_id, centre_id, evidence, requires_decision, consequence)
         values ($1, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, true, $6)
         returning id`,
        [LEG_OVERDUE, r.package_id, r.id, r.centre_id, JSON.stringify(alert.evidence), alert.consequence],
      );
      raised.push({
        alertId: inserted[0]!.id,
        legId: r.id,
        legNo: r.leg_no,
        overdueBySeconds: alert.evidence["overdueBySeconds"] as number,
      });
    }

    await client.query("commit");
    return raised;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface Log {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Sweep now, then every `intervalMs`. Returns a function that stops it.
 *
 * The default interval is 30 seconds so a leg is flagged within a minute of
 * its expected time, whatever the phase of the timer when it went late.
 */
export function startLegWatchdog(pool: Pool, log: Log, intervalMs: number): () => void {
  let running = false;
  const tick = async () => {
    // A sweep that takes longer than the interval must not overlap itself;
    // the advisory lock would serialise them anyway, but a queue of waiting
    // sweeps is a pool of held connections doing nothing.
    if (running) return;
    running = true;
    try {
      const raised = await sweepOverdueLegs(pool);
      for (const r of raised) {
        log.info(r, `LEG_OVERDUE leg ${r.legNo}, ${r.overdueBySeconds}s past expected-by`);
      }
    } catch (err) {
      // Keep sweeping. A watchdog that stops on a transient database error is
      // a watchdog that is not watching, and nothing would notice.
      log.error({ err }, "leg watchdog sweep failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
