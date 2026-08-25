import type { Pool, PoolClient } from "pg";
import {
  generateCustodyKey,
  epochAt,
  epochWindow,
  epochStart,
  epochEnd,
  EPOCH_SECONDS,
} from "@mohar/crypto-core";
import type { AccessDecision, AccessRequest } from "./policy.js";

/**
 * Issuance, rotation and audit of custody access keys.
 *
 * Rotation is not a background job. A key is scoped to a six-hour epoch derived
 * from the clock, so if nothing ever calls `rotateAll` the effect is that keys
 * stop existing for the current epoch and access is refused — not that stale
 * keys keep working. Failure closes.
 */

export interface IssuedKey {
  id: string;
  packageId: string;
  stage: string;
  epoch: number;
  fingerprint: string;
  issuedToRole: string;
  issuedToPerson: string | null;
  validFrom: string;
  validTo: string;
  revokedAt: string | null;
  revokedReason: string | null;
  /** Present ONLY in the response that issues it. Never stored, never re-shown. */
  key?: string;
}

function rowToKey(r: Record<string, unknown>): IssuedKey {
  return {
    id: r["id"] as string,
    packageId: r["package_id"] as string,
    stage: r["stage"] as string,
    epoch: Number(r["epoch"]),
    fingerprint: r["fingerprint"] as string,
    issuedToRole: r["issued_to_role"] as string,
    issuedToPerson: (r["issued_to_person"] as string) ?? null,
    validFrom: (r["valid_from"] as Date).toISOString(),
    validTo: (r["valid_to"] as Date).toISOString(),
    revokedAt: r["revoked_at"] ? (r["revoked_at"] as Date).toISOString() : null,
    revokedReason: (r["revoked_reason"] as string) ?? null,
  };
}

export async function listStages(pool: Pool) {
  const { rows } = await pool.query(
    "select stage, ordinal, description, expected_role from led.custody_stage order by ordinal",
  );
  return rows.map((r) => ({
    stage: r.stage,
    ordinal: r.ordinal,
    description: r.description,
    expectedRole: r.expected_role,
  }));
}

/**
 * Issue the key for one (package, stage) in a given epoch.
 *
 * Idempotent per epoch by the unique constraint: asking twice in the same
 * six-hour window returns the existing record rather than minting a second key,
 * because two live keys for one stage would mean the holder of either could act
 * and neither could be held responsible.
 *
 * The plaintext key is returned exactly once, here. Nothing persists it.
 */
export async function issueKey(
  tx: PoolClient,
  input: {
    packageId: string;
    stage: string;
    epoch?: number;
    issuedToPerson?: string | null;
  },
): Promise<{ key: IssuedKey; created: boolean }> {
  const epoch = input.epoch ?? epochAt();

  const existing = await tx.query(
    "select * from led.access_key where package_id = $1 and stage = $2 and epoch = $3",
    [input.packageId, input.stage, epoch],
  );
  if (existing.rows[0]) {
    return { key: rowToKey(existing.rows[0]), created: false };
  }

  const { rows: stageRows } = await tx.query(
    "select expected_role from led.custody_stage where stage = $1",
    [input.stage],
  );
  const expectedRole = stageRows[0]?.expected_role;
  if (!expectedRole) throw new Error(`unknown custody stage "${input.stage}"`);

  const { key, keyHashHex, fingerprint } = generateCustodyKey(input.stage);
  const { validFrom, validTo } = epochWindow(epoch);

  const { rows } = await tx.query(
    `insert into led.access_key
       (package_id, stage, epoch, key_hash, fingerprint,
        issued_to_person, issued_to_role, valid_from, valid_to)
     values ($1,$2,$3, decode($4,'hex'), $5, $6, $7, $8, $9)
     returning *`,
    [
      input.packageId,
      input.stage,
      epoch,
      keyHashHex,
      fingerprint,
      input.issuedToPerson ?? null,
      expectedRole,
      validFrom,
      validTo,
    ],
  );

  return { key: { ...rowToKey(rows[0]), key }, created: true };
}

/**
 * Issue keys for every stage of every active package in the current epoch.
 *
 * "Active" excludes packages already returned or compromised: a compromised
 * package must not acquire a fresh working key just because the clock rolled
 * over, and a returned one has nothing left to protect.
 */
export async function rotateAll(
  pool: Pool,
  epoch = epochAt(),
): Promise<{ epoch: number; issued: IssuedKey[]; skipped: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const { rows: pkgs } = await client.query(
      `select id from ref.package
        where state not in ('returned','compromised')`,
    );
    const { rows: stages } = await client.query(
      "select stage from led.custody_stage order by ordinal",
    );

    const issued: IssuedKey[] = [];
    let skipped = 0;
    for (const p of pkgs) {
      for (const s of stages) {
        const { key, created } = await issueKey(client, {
          packageId: p.id,
          stage: s.stage,
          epoch,
        });
        if (created) issued.push(key);
        else skipped++;
      }
    }

    await client.query("commit");
    return { epoch, issued, skipped };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeKey(
  pool: Pool,
  keyId: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update led.access_key
        set revoked_at = now(), revoked_reason = $2
      where id = $1 and revoked_at is null`,
    [keyId, reason],
  );
  return (rowCount ?? 0) > 0;
}

export async function listKeys(
  pool: Pool,
  filter: { packageId?: string; epoch?: number; activeOnly?: boolean } = {},
): Promise<IssuedKey[]> {
  const { rows } = await pool.query(
    `select k.*, p.id as pkg
       from led.access_key k
       join ref.package p on p.id = k.package_id
      where ($1::uuid is null or k.package_id = $1::uuid)
        and ($2::bigint is null or k.epoch = $2::bigint)
        and ($3::boolean is false or (k.revoked_at is null and now() between k.valid_from and k.valid_to))
      order by k.epoch desc, k.stage`,
    [filter.packageId ?? null, filter.epoch ?? null, filter.activeOnly ?? false],
  );
  return rows.map(rowToKey);
}

/** Where we are in the current six-hour window — drives the UI countdown. */
export function epochStatus(now = new Date()) {
  const epoch = epochAt(now);
  const start = epochStart(epoch);
  const end = epochEnd(epoch);
  const elapsed = (now.getTime() - start.getTime()) / 1000;
  return {
    epoch,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    secondsRemaining: Math.max(0, Math.round(EPOCH_SECONDS - elapsed)),
    percentElapsed: Math.min(100, Math.round((elapsed / EPOCH_SECONDS) * 100)),
  };
}

/**
 * Persist an attempt. Called for every decision, granted or refused, before any
 * event is appended — so a crash between deciding and appending still leaves
 * evidence that the attempt happened.
 */
export async function recordAttempt(
  tx: PoolClient,
  req: AccessRequest,
  decision: AccessDecision,
  meta: { examId: string | null; centreId: string | null; eventId?: string | null },
): Promise<{ seq: string; id: string }> {
  const c = decision.context;
  const { rows } = await tx.query(
    `insert into led.access_attempt (
       package_id, centre_id, exam_id, stage,
       presented_fingerprint, key_id, key_epoch, current_epoch,
       actor_device, actor_person, actor_role,
       outcome, deny_reasons, checks_passed,
       lat, lon, geo_accuracy_m, distance_m,
       seal_serial_read, clock_skew_ms, device_kind, session_id,
       event_id, attempted_at
     ) values (
       $1,$2,$3,$4,
       $5,$6,$7,$8,
       $9,$10,$11,
       $12,$13,$14,
       $15,$16,$17,$18,
       $19,$20,$21,$22,
       $23,$24
     ) returning seq, id`,
    [
      req.packageId,
      meta.centreId,
      meta.examId,
      req.stage,
      c.presentedFingerprint,
      c.keyId,
      c.keyEpoch,
      c.currentEpoch,
      req.deviceId,
      req.personId ?? null,
      c.actorRole,
      decision.outcome,
      decision.denyReasons,
      decision.checksPassed,
      req.geo?.lat ?? null,
      req.geo?.lon ?? null,
      req.geo?.accuracyM ?? null,
      c.distanceM,
      req.sealSerialRead ?? null,
      c.clockSkewMs,
      c.deviceKind,
      req.sessionId,
      meta.eventId ?? null,
      req.occurredAt,
    ],
  );
  return { seq: rows[0].seq, id: rows[0].id };
}

export interface AttemptRecord {
  seq: string;
  id: string;
  packageId: string | null;
  centreCode: string | null;
  stage: string | null;
  outcome: "granted" | "denied";
  denyReasons: string[];
  checksPassed: string[];
  presentedFingerprint: string | null;
  keyId: string | null;
  keyEpoch: number | null;
  currentEpoch: number;
  keyStatus: "valid" | "expired" | "unknown" | "revoked" | "not_presented";
  actorDeviceId: string | null;
  actorPersonName: string | null;
  actorRole: string | null;
  deviceKind: string | null;
  lat: number | null;
  lon: number | null;
  geoAccuracyM: number | null;
  distanceM: number | null;
  sealSerialRead: string | null;
  clockSkewMs: number | null;
  sessionId: string | null;
  eventId: string | null;
  attemptedAt: string;
  decidedAt: string;
}

/**
 * Derive how the key fared, for display. Recomputed from the stored columns
 * rather than stored as a label, so it stays correct if the rules change.
 */
function keyStatus(r: Record<string, unknown>): AttemptRecord["keyStatus"] {
  if (!r["presented_fingerprint"]) return "not_presented";
  if (!r["key_id"]) return "unknown";
  const reasons = (r["deny_reasons"] as string[]) ?? [];
  if (reasons.includes("key_revoked")) return "revoked";
  if (reasons.includes("key_expired") || reasons.includes("key_not_yet_valid")) return "expired";
  return "valid";
}

export async function listAttempts(
  pool: Pool,
  filter: {
    packageId?: string;
    outcome?: "granted" | "denied";
    limit?: number;
    examId?: string;
  } = {},
): Promise<AttemptRecord[]> {
  const { rows } = await pool.query(
    `select a.*, c.code as centre_code, p.display_name as person_name
       from led.access_attempt a
       left join ref.centre c on c.id = a.centre_id
       left join ref.person p on p.id = a.actor_person
      where ($1::uuid is null or a.package_id = $1::uuid)
        and ($2::text is null or a.outcome = $2::text)
        and ($3::uuid is null or a.exam_id = $3::uuid)
      order by a.seq desc
      limit $4`,
    [
      filter.packageId ?? null,
      filter.outcome ?? null,
      filter.examId ?? null,
      Math.min(filter.limit ?? 200, 1000),
    ],
  );

  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    packageId: r.package_id,
    centreCode: r.centre_code,
    stage: r.stage,
    outcome: r.outcome,
    denyReasons: r.deny_reasons ?? [],
    checksPassed: r.checks_passed ?? [],
    presentedFingerprint: r.presented_fingerprint,
    keyId: r.key_id,
    keyEpoch: r.key_epoch === null ? null : Number(r.key_epoch),
    currentEpoch: Number(r.current_epoch),
    keyStatus: keyStatus(r),
    actorDeviceId: r.actor_device,
    actorPersonName: r.person_name,
    actorRole: r.actor_role,
    deviceKind: r.device_kind,
    lat: r.lat,
    lon: r.lon,
    geoAccuracyM: r.geo_accuracy_m,
    distanceM: r.distance_m,
    sealSerialRead: r.seal_serial_read,
    clockSkewMs: r.clock_skew_ms === null ? null : Number(r.clock_skew_ms),
    sessionId: r.session_id,
    eventId: r.event_id,
    attemptedAt: (r.attempted_at as Date).toISOString(),
    decidedAt: (r.decided_at as Date).toISOString(),
  }));
}
