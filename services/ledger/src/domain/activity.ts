import type { Pool } from "pg";

/**
 * The activity ledger — every recorded act, stated as fact.
 *
 * This deliberately replaces the earlier severity-labelled alarm feed. A label
 * like "critical" is someone's opinion compressed into one word, and it is the
 * wrong thing to put in front of an operator who has to decide something: it
 * tells them how to feel and not what happened. What they need is the act, the
 * actor, the key that was presented, whether it verified, where the device was,
 * and what the engine checked.
 *
 * So each row here carries the facts and lets the reader draw the conclusion.
 * The one thing we do assert is `requiresDecision`, which is not a severity but
 * a statement about workflow: this act has consequences nobody has acknowledged.
 */

export interface ActivityEntry {
  /** Ordering key across both sources. Ledger events use their seq. */
  ref: string;
  source: "event" | "access_attempt";
  at: string;
  recordedAt: string;

  /** What happened, in plain words. */
  act: string;
  /** The full factual account. Several lines, no adjectives. */
  facts: string[];

  kind: string;
  stage: string | null;
  examName: string | null;
  centreCode: string | null;
  packageId: string | null;

  actorRole: string | null;
  actorPerson: string | null;
  actorDeviceId: string | null;
  deviceKind: string | null;

  /** Key outcome — the thing the operator asked to see on every row. */
  key: {
    presented: boolean;
    fingerprint: string | null;
    status: "verified" | "expired" | "unknown" | "revoked" | "not_presented" | "n/a";
    epochPresented: number | null;
    epochCurrent: number | null;
    detail: string;
  };

  outcome: "granted" | "denied" | "recorded";
  denyReasons: string[];
  checksPassed: string[];

  position: { lat: number; lon: number; accuracyM: number | null; distanceM: number | null } | null;
  clockSkewMs: number | null;
  sealSerialRead: string | null;

  /** True when this act has consequences no one has resolved. */
  requiresDecision: boolean;
  consequence: string | null;

  eventHash: string | null;
  payload: unknown;
}

/**
 * What each event kind means, and what it obliges someone to do.
 *
 * `consequence` is drawn straight from the field-ops runbook. It is an
 * instruction, not an assessment — "stop, do not print" is actionable in a way
 * that "critical" is not.
 */
interface EventMeaning {
  act: string;
  requiresDecision?: boolean;
  consequence?: string;
}

const EVENT_MEANING: Record<string, EventMeaning> = {
  PACKAGE_SEALED: { act: "Package sealed and shares distributed" },
  SEAL_APPLIED: { act: "Numbered plastic seal fitted" },
  HANDOFF: { act: "Custody transferred" },
  SCAN_OBSERVED: { act: "Package identifier scanned" },
  ACCESS_REQUESTED: { act: "Authorisation session opened" },
  ACCESS_GRANTED: { act: "Access granted" },
  ACCESS_DENIED: { act: "Access refused" },
  OVERRIDE_USED: {
    act: "Operator proceeded past a refusal",
    requiresDecision: true,
    consequence:
      "The refusal was overruled by a human. Confirm the justification with the " +
      "superintendent and the observer independently, and record the outcome.",
  },
  SEAL_MISMATCH: {
    act: "Seal serial did not match the registered serial",
    requiresDecision: true,
    consequence:
      "Runbook: stop. Do not print. Escalate to the authority and the police. " +
      "The paper is presumed compromised until proven otherwise.",
  },
  MONITOR_HEARTBEAT: { act: "Room monitor reported in" },
  MONITOR_SILENT: {
    act: "Room monitor stopped reporting",
    requiresDecision: true,
    consequence:
      "Unplugging the monitor is the cheapest way to blind a room. Confirm the " +
      "cause physically before treating it as a fault.",
  },
  ROOM_ENTRY: { act: "Room entry recorded" },
  WITNESS_ASSERTED: { act: "Official authenticated at the witness station" },
  WITNESS_CEREMONY: { act: "Two-person witness window closed" },
  WITNESS_FRAME: { act: "Witness photograph committed to the chain" },
  SHARE_RELEASED: { act: "Shamir share released" },
  FALLBACK_INVOKED: {
    act: "Out-of-band key fallback invoked",
    requiresDecision: true,
    consequence:
      "This is the weakest path in the design and its invocation rate is " +
      "published. Confirm both authorisers independently and record why the " +
      "normal path was unavailable.",
  },
  PRINT_STARTED: { act: "Printing started" },
  PRINT_COMPLETED: { act: "Printing completed" },
  KEY_DESTROYED: { act: "Content key zeroised" },
  EXCEPTION_RAISED: {
    act: "Operator raised an exception",
    requiresDecision: true,
    consequence: "Someone had to work around the system. Read the detail and decide whether it recurs.",
  },
};

function factsForEvent(kind: string, payload: Record<string, unknown>): string[] {
  const f: string[] = [];
  const p = (k: string) => payload[k];

  switch (kind) {
    case "PACKAGE_SEALED":
      f.push(`${p("copies")} copies sealed`);
      f.push(`Ciphertext SHA-256 ${String(p("ciphertextSha256")).slice(0, 24)}…`);
      f.push(`Timelock bound to drand round ${p("drandRound")}`);
      f.push(`${(p("shareCommitments") as string[])?.length ?? 0} Shamir share commitments recorded`);
      break;
    case "SEAL_APPLIED":
      f.push(`Seal serial ${p("sealSerial")}`);
      f.push(`Seal photo SHA-256 ${String(p("photoSha256")).slice(0, 24)}…`);
      break;
    case "HANDOFF":
      f.push(`${p("fromRole")} → ${p("toRole")}`);
      f.push(`Package state becomes "${p("toState")}"`);
      f.push(`Seal ${p("sealSerial")} verified in frame with the package`);
      f.push("Both parties signed; two distinct enrolled devices required");
      break;
    case "ACCESS_DENIED":
      f.push(`Refused for: ${((p("reasons") as string[]) ?? []).join(", ")}`);
      break;
    case "ACCESS_GRANTED":
      f.push(`Checks passed: ${((p("checksPassed") as string[]) ?? []).join(", ")}`);
      f.push(`Decision receipt ${String(p("receiptSha256")).slice(0, 24)}…`);
      break;
    case "OVERRIDE_USED":
      f.push(`Original refusal: ${((p("deniedReasons") as string[]) ?? []).join(", ")}`);
      f.push(`Justification given: "${p("justification")}"`);
      f.push(`Photo evidence ${String(p("photoSha256")).slice(0, 24)}…`);
      f.push("Countersigned — a second enrolled device was required");
      break;
    case "SEAL_MISMATCH":
      f.push(`Registered serial: ${p("expectedSerial")}`);
      f.push(`Serial actually read: ${p("observedSerial")}`);
      f.push(`Photo evidence ${String(p("photoSha256")).slice(0, 24)}…`);
      break;
    case "MONITOR_SILENT":
      f.push(`${p("missedCount")} consecutive heartbeats missed`);
      f.push(`Last contact ${p("lastHeartbeatAt")}`);
      break;
    case "ROOM_ENTRY":
      f.push(`Door ${p("doorOpen") ? "open" : "closed"}, light ${p("lightOn") ? "on" : "off"}`);
      f.push(`At least ${p("enteredAtLeast")} entered, at least ${p("exitedAtLeast")} left`);
      f.push(`mmWave presence: ${p("presence") ? "someone in the room" : "room empty"}`);
      f.push("Counts are floors — two people abreast register as one");
      break;
    case "WITNESS_ASSERTED":
      f.push(`Template slot ${p("templateSlot")} matched, score ${p("matchScore")}`);
      f.push(`Recorded as the ${p("role")}`);
      f.push(
        Number(p("frameBytes")) > 0
          ? `Frame of ${p("frameBytes")} bytes, SHA-256 ${String(p("frameSha256")).slice(0, 24)}…`
          : "No frame was captured — this assertion has no visual corroboration",
      );
      f.push("Optical readers are spoofable with a lifted print; this is evidence of presence, not proof of identity");
      break;
    case "WITNESS_CEREMONY":
      f.push(`Outcome: ${String(p("outcome")).replace(/_/g, " ")}`);
      f.push(`${p("assertionCount")} assertion(s) inside a ${p("windowSeconds")} s window`);
      f.push(
        p("distinctSlots")
          ? "Two distinct enrolled templates"
          : "Not two distinct templates — this is not a two-person act",
      );
      break;
    case "WITNESS_FRAME":
      f.push(`Frame ${p("width")}\u00d7${p("height")}, ${p("frameBytes")} bytes`);
      f.push(`SHA-256 ${String(p("frameSha256")).slice(0, 24)}\u2026`);
      f.push("The image is held outside the chain; only this hash is committed");
      f.push("Captured by the centre PC, not by the station that read the finger");
      break;
    case "PRINT_STARTED":
      f.push(`${p("copiesRequested")} copies requested`);
      break;
    case "PRINT_COMPLETED":
      f.push(`${p("copiesPrinted")} printed, ${p("copiesSpoiled")} spoiled`);
      f.push(`Serials ${p("firstSerial")} → ${p("lastSerial")}`);
      break;
    case "KEY_DESTROYED":
      f.push(`Method: ${String(p("method")).replace(/_/g, " ")}`);
      break;
    case "FALLBACK_INVOKED":
      f.push(`Share index ${p("shareIndex")}`);
      break;
    case "EXCEPTION_RAISED":
      f.push(`Code ${p("code")}`);
      f.push(String(p("detail")));
      break;
  }
  return f;
}

/** Human account of what the key did, for the access-attempt rows. */
function keyDetail(
  status: ActivityEntry["key"]["status"],
  fingerprint: string | null,
  keyEpoch: number | null,
  currentEpoch: number | null,
): string {
  switch (status) {
    case "not_presented":
      return "No custody key was presented with this request.";
    case "unknown":
      return `Key ${fingerprint} matches nothing ever issued for this package. Either a key from another package was tried, or someone is guessing.`;
    case "expired": {
      const behind = currentEpoch !== null && keyEpoch !== null ? currentEpoch - keyEpoch : null;
      return (
        `Key ${fingerprint} was issued for epoch ${keyEpoch}; the current epoch is ${currentEpoch}` +
        (behind ? ` — ${behind} rotation${behind === 1 ? "" : "s"} out of date (${behind * 6} hours).` : ".")
      );
    }
    case "revoked":
      return `Key ${fingerprint} had been revoked before this attempt.`;
    case "verified":
      return `Key ${fingerprint} verified against the hash issued for epoch ${keyEpoch}.`;
    default:
      return "This act does not pass through the key-gated access engine.";
  }
}

export async function listActivity(
  pool: Pool,
  opts: {
    limit?: number;
    examId?: string;
    packageId?: string;
    onlyDecisions?: boolean;
    onlyDenied?: boolean;
  } = {},
): Promise<ActivityEntry[]> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const entries: ActivityEntry[] = [];

  // ── access attempts ──
  const { rows: attempts } = await pool.query(
    `select a.*, c.code as centre_code, p.display_name as person_name,
            x.name as exam_name
       from led.access_attempt a
       left join ref.centre c on c.id = a.centre_id
       left join ref.person p on p.id = a.actor_person
       left join ref.exam   x on x.id = a.exam_id
      where ($1::uuid is null or a.exam_id = $1::uuid)
        and ($2::uuid is null or a.package_id = $2::uuid)
        and ($3::boolean is false or a.outcome = 'denied')
      order by a.seq desc
      limit $4`,
    [opts.examId ?? null, opts.packageId ?? null, opts.onlyDenied ?? false, limit],
  );

  for (const r of attempts) {
    const reasons: string[] = r.deny_reasons ?? [];
    const status: ActivityEntry["key"]["status"] = !r.presented_fingerprint
      ? "not_presented"
      : !r.key_id
        ? "unknown"
        : reasons.includes("key_revoked")
          ? "revoked"
          : reasons.includes("key_expired") || reasons.includes("key_not_yet_valid")
            ? "expired"
            : "verified";

    const facts: string[] = [];
    facts.push(
      `Stage "${r.stage}" — ${r.outcome === "granted" ? "authorised" : "refused"} by the access engine`,
    );
    if (r.distance_m !== null) {
      facts.push(`Device ${Math.round(r.distance_m)} m from the centre`);
    }
    if (r.geo_accuracy_m !== null) {
      facts.push(`Position fix accurate to ${Math.round(r.geo_accuracy_m)} m`);
    }
    if (r.seal_serial_read) facts.push(`Seal serial read: ${r.seal_serial_read}`);
    if (r.clock_skew_ms !== null) {
      facts.push(`Device clock ${Math.round(Number(r.clock_skew_ms) / 1000)} s from server time`);
    }
    facts.push(
      `${(r.checks_passed ?? []).length} of ${(r.checks_passed ?? []).length + reasons.length} checks passed`,
    );
    if (reasons.length) facts.push(`Failed: ${reasons.join(", ")}`);

    entries.push({
      ref: `a${r.seq}`,
      source: "access_attempt",
      at: (r.attempted_at as Date).toISOString(),
      recordedAt: (r.decided_at as Date).toISOString(),
      act: r.outcome === "granted" ? "Access authorised" : "Access refused",
      facts,
      kind: r.outcome === "granted" ? "ACCESS_GRANTED" : "ACCESS_DENIED",
      stage: r.stage,
      examName: r.exam_name,
      centreCode: r.centre_code,
      packageId: r.package_id,
      actorRole: r.actor_role,
      actorPerson: r.person_name,
      actorDeviceId: r.actor_device,
      deviceKind: r.device_kind,
      key: {
        presented: !!r.presented_fingerprint,
        fingerprint: r.presented_fingerprint,
        status,
        epochPresented: r.key_epoch === null ? null : Number(r.key_epoch),
        epochCurrent: Number(r.current_epoch),
        detail: keyDetail(
          status,
          r.presented_fingerprint,
          r.key_epoch === null ? null : Number(r.key_epoch),
          Number(r.current_epoch),
        ),
      },
      outcome: r.outcome,
      denyReasons: reasons,
      checksPassed: r.checks_passed ?? [],
      position:
        r.lat !== null
          ? { lat: r.lat, lon: r.lon, accuracyM: r.geo_accuracy_m, distanceM: r.distance_m }
          : null,
      clockSkewMs: r.clock_skew_ms === null ? null : Number(r.clock_skew_ms),
      sealSerialRead: r.seal_serial_read,
      // An unrecognised or stale key against a real package is not a typo, and
      // nobody should have to notice it in a list to act on it.
      requiresDecision:
        r.outcome === "denied" && (status === "unknown" || status === "expired" || status === "revoked"),
      consequence:
        status === "unknown"
          ? "A key nobody issued was presented against this package. Establish where it came from before the next epoch rotates."
          : status === "expired"
            ? "A stale key was presented. Confirm the holder still has custody and has not passed their key on."
            : status === "revoked"
              ? "A revoked key was presented. The holder was not told, or ignored being told."
              : null,
      eventHash: null,
      payload: null,
    });
  }

  // ── signed ledger events ──
  // `onlyDenied` implies `onlyDecisions`: a refusal is something the engine
  // ruled on, and a signed event has no outcome to refuse. Without this, asking
  // for refusals returns every ordinary event alongside them.
  if (!opts.onlyDecisions && !opts.onlyDenied) {
    const { rows: events } = await pool.query(
      `select e.seq, e.id, e.kind, e.occurred_at, e.received_at, e.clock_skew_ms,
              e.body, e.lat, e.lon, e.geo_accuracy_m,
              e.actor_device, e.package_id,
              encode(e.hash,'hex') as hash,
              c.code as centre_code, p.display_name as person_name,
              p.role as person_role, d.kind as device_kind,
              x.name as exam_name
         from led.event e
         left join ref.centre c on c.id = e.centre_id
         left join ref.person p on p.id = e.actor_person
         left join ref.device d on d.id = e.actor_device
         left join ref.exam   x on x.id = e.exam_id
        where ($1::uuid is null or e.exam_id = $1::uuid)
          and ($2::uuid is null or e.package_id = $2::uuid)
        order by e.seq desc
        limit $3`,
      [opts.examId ?? null, opts.packageId ?? null, limit],
    );

    for (const r of events) {
      const body = r.body as { payload?: Record<string, unknown> };
      const meaning: EventMeaning = EVENT_MEANING[r.kind] ?? { act: r.kind as string };
      const facts = factsForEvent(r.kind, body.payload ?? {});

      const skew = Number(r.clock_skew_ms);
      if (Math.abs(skew) > 300_000) {
        facts.push(
          `Device clock ${Math.round(skew / 1000)} s from server — recorded, never silently corrected`,
        );
      }

      entries.push({
        ref: `e${r.seq}`,
        source: "event",
        at: (r.occurred_at as Date).toISOString(),
        recordedAt: (r.received_at as Date).toISOString(),
        act: meaning.act,
        facts,
        kind: r.kind,
        stage: null,
        examName: r.exam_name,
        centreCode: r.centre_code,
        packageId: r.package_id,
        actorRole: r.person_role,
        actorPerson: r.person_name,
        actorDeviceId: r.actor_device,
        deviceKind: r.device_kind,
        key: {
          presented: false,
          fingerprint: null,
          status: "n/a",
          epochPresented: null,
          epochCurrent: null,
          detail:
            "Signed directly by an enrolled device key; this act does not pass through the custody-key gate.",
        },
        outcome: "recorded",
        denyReasons: [],
        checksPassed: [],
        position:
          r.lat !== null
            ? { lat: r.lat, lon: r.lon, accuracyM: r.geo_accuracy_m, distanceM: null }
            : null,
        clockSkewMs: skew,
        sealSerialRead: null,
        requiresDecision: meaning.requiresDecision ?? false,
        consequence: meaning.consequence ?? null,
        eventHash: r.hash,
        payload: body.payload ?? null,
      });
    }
  }

  return entries
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .slice(0, limit);
}

/** Counters for the dashboard — all factual, none of them a severity. */
export async function operationalSummary(pool: Pool, examId?: string) {
  const { rows: pkg } = await pool.query(
    `select state, count(*)::int as n from ref.package
      where ($1::uuid is null or exam_id = $1::uuid) group by state`,
    [examId ?? null],
  );

  const { rows: acc } = await pool.query(
    `select outcome, count(*)::int as n from led.access_attempt
      where ($1::uuid is null or exam_id = $1::uuid) group by outcome`,
    [examId ?? null],
  );

  const { rows: keyStats } = await pool.query(
    `select
       count(*) filter (where revoked_at is null and now() between valid_from and valid_to)::int as active,
       count(*) filter (where revoked_at is not null)::int as revoked,
       count(*)::int as total
     from led.access_key`,
  );

  // Denials where the key itself was the problem — the ones worth chasing.
  const { rows: badKey } = await pool.query(
    `select count(*)::int as n from led.access_attempt
      where outcome = 'denied'
        and (deny_reasons && array['key_unknown','key_expired','key_revoked','key_wrong_stage'])
        and ($1::uuid is null or exam_id = $1::uuid)`,
    [examId ?? null],
  );

  const { rows: open } = await pool.query(
    `select count(*)::int as n from led.event
      where kind in ('SEAL_MISMATCH','OVERRIDE_USED','FALLBACK_INVOKED','MONITOR_SILENT','EXCEPTION_RAISED')
        and ($1::uuid is null or exam_id = $1::uuid)`,
    [examId ?? null],
  );

  const { rows: totals } = await pool.query(
    `select (select count(*) from led.event)::int as events,
            (select count(*) from led.access_attempt)::int as attempts,
            (select count(*) from ref.device where revoked_at is null)::int as active_devices,
            (select count(*) from ref.centre)::int as centres,
            (select count(*) from led.anchor)::int as anchors`,
  );

  return {
    packagesByState: Object.fromEntries(pkg.map((r) => [r.state, r.n])),
    access: Object.fromEntries(acc.map((r) => [r.outcome, r.n])),
    keys: keyStats[0],
    keyDenials: badKey[0].n,
    actsRequiringDecision: open[0].n,
    totals: totals[0],
  };
}
