import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type CustodyAnomaly, type TimelineEvent } from "../lib/api";
import { useAsync, formatTime, relativeTime } from "../lib/hooks";
import { Card, Empty, ErrorNote, StateBadge, RiskMeter } from "../components/ui";

/**
 * The full workflow of one package: every event in order, with everything the
 * ledger holds about it.
 *
 * This screen is what an investigator reads, so nothing is summarised away. Each
 * entry carries who acted, on which device, where they were standing, how far
 * their clock was from ours, and the two hashes that fix the event in sequence.
 * The payload is shown verbatim rather than rewritten into prose — a paraphrase
 * cannot be checked against a signature, and this record has to stand up as
 * evidence.
 */

/** What each event kind means, in one plain sentence. */
const MEANING: Record<string, string> = {
  PACKAGE_SEALED: "The authority encrypted the paper bundle and split its key into shares.",
  SEAL_APPLIED: "A numbered one-time plastic seal was fitted and photographed.",
  HANDOFF: "Custody passed from one person to another. Both signed, on separate devices.",
  SCAN_OBSERVED: "The package identifier was read. A scan on its own authorises nothing.",
  ACCESS_FRAME:
    "A photograph was taken at the terminal when this decision was returned, and its digest committed here. The image itself is not in the chain.",
  ACCESS_REQUESTED: "Someone opened an authorisation session against this package.",
  ACCESS_GRANTED: "The policy engine allowed the request after every check passed.",
  ACCESS_DENIED: "The policy engine refused the request. The failing checks are in the payload.",
  OVERRIDE_USED: "A person proceeded after being refused. Countersigned and photographed.",
  SEAL_MISMATCH: "The seal read did not match the one registered. Treat as compromised.",
  MONITOR_HEARTBEAT: "The room monitor reported in on schedule.",
  MONITOR_SILENT: "The room monitor stopped reporting.",
  ROOM_ENTRY: "The door opened and the monitor recorded movement.",
  SHARE_RELEASED: "One Shamir share of the content key was released.",
  FALLBACK_INVOKED: "The out-of-band key path was used. Requires two authorisers.",
  PRINT_STARTED: "Printing began. Readable paper exists from this moment.",
  PRINT_COMPLETED: "Printing finished, with copy counts and serial range.",
  KEY_DESTROYED: "The content key was zeroised. The exposure window closes here.",
  EXCEPTION_RAISED: "An operator recorded something they had to work around.",
};

const BAD = new Set([
  "SEAL_MISMATCH", "OVERRIDE_USED", "ACCESS_DENIED", "FALLBACK_INVOKED", "MONITOR_SILENT",
]);
const GOOD = new Set([
  "HANDOFF", "ACCESS_GRANTED", "PRINT_COMPLETED", "KEY_DESTROYED", "PACKAGE_SEALED",
]);

/**
 * Anomalies are rendered with *what it means* and *why it matters*, not just a
 * code. The person reading this at 3am is a duty officer deciding whether to
 * wake a district magistrate; a raw enum does not help them make that call.
 */
function describe(a: CustodyAnomaly): { what: string; why: string } {
  switch (a.code) {
    case "seal_serial_changed":
      return {
        what: `Seal read as "${a.read}" but "${a.registered}" was registered.`,
        why: "Runbook: stop, do not print, escalate to the authority and police. The paper is presumed compromised.",
      };
    case "custody_gap":
      return {
        what: `${Math.round(a.gapMinutes / 60)} hours in transit with nothing recorded (events #${a.fromSeq} → #${a.toSeq}).`,
        why: "Unaccounted handling time is the window in which a package can be opened and photographed with no trace.",
      };
    case "handoff_holder_mismatch":
      return {
        what: `Handed off by someone who was not recorded as holding it (expected ${a.expectedHolder.slice(0, 8)}…, claimed ${a.claimedFrom.slice(0, 8)}…).`,
        why: "Either a hop went unrecorded or this handoff was fabricated. Both break the chain of accountability.",
      };
    case "illegal_transition":
      return {
        what: `Moved from "${a.from}" straight to "${a.to}", which the lifecycle does not allow.`,
        why: "A skipped state usually means a custody step happened without anyone recording it.",
      };
    case "printed_without_grant":
      return {
        what: `Printing began at event #${a.seq} with no access grant on record.`,
        why: "The policy engine was bypassed entirely rather than overruled — an override would at least have left its own event.",
      };
    case "opened_before_window":
      return {
        what: `Opened before the custody window opened at ${formatTime(a.windowOpensAt)}.`,
        why: "Early opening is the single highest-value indicator of a leak in progress.",
      };
    case "key_not_destroyed":
      return {
        what: `Printing completed (event #${a.lastPrintSeq}) but no zeroisation was ever recorded.`,
        why: "A content key is unaccounted for. The exposure window for this package is still open.",
      };
  }
}

function Event({
  e,
  hop,
}: {
  e: TimelineEvent;
  hop?: { fromRole?: string; toRole?: string; state: string };
}) {
  const bad = BAD.has(e.kind);
  const skew = Math.round(e.clockSkewMs / 1000);

  return (
    <div className={`tl-item${bad ? " flag" : GOOD.has(e.kind) ? " good" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span className="tl-kind" style={bad ? { color: "var(--critical)" } : undefined}>
          {e.kind}
        </span>
        <span className="tl-time" title={`Received by the ledger ${formatTime(e.receivedAt)}`}>
          #{e.seq} · {formatTime(e.occurredAt)} · {relativeTime(e.occurredAt)}
        </span>
      </div>

      {MEANING[e.kind] && <div className="tl-meaning">{MEANING[e.kind]}</div>}

      <dl className="tl-facts">
        <dt>Actor</dt>
        <dd>
          {e.actorName ?? "unattributed"}
          {e.actorRole ? ` (${e.actorRole.replace(/_/g, " ")})` : ""}
        </dd>

        {hop?.fromRole && (
          <>
            <dt>Transfer</dt>
            <dd>
              {hop.fromRole.replace(/_/g, " ")} → {hop.toRole?.replace(/_/g, " ")}
              {" · now "}
              {hop.state.replace(/_/g, " ")}
            </dd>
          </>
        )}

        <dt>Device</dt>
        <dd>
          {e.deviceKind ?? "unknown"} · {e.actorDeviceId.slice(0, 8)}
          {e.cosignDeviceId ? ` · countersigned ${e.cosignDeviceId.slice(0, 8)}` : ""}
        </dd>

        {e.lat !== null && e.lon !== null && (
          <>
            <dt>Position</dt>
            <dd>
              {e.lat.toFixed(5)}, {e.lon.toFixed(5)}
              {e.geoAccuracyM !== null ? ` ±${Math.round(e.geoAccuracyM)}m` : ""}
            </dd>
          </>
        )}

        <dt>Clock</dt>
        <dd
          {...(Math.abs(skew) > 300 ? { style: { color: "var(--high)" } } : {})}
          title="Device clock minus server clock. Recorded, never silently corrected."
        >
          {skew > 0 ? "+" : ""}
          {skew}s from server
        </dd>

        <dt>Body hash</dt>
        <dd title="SHA-256 of the canonical body — exactly what the device signature covers.">
          {e.bodyHash.slice(0, 24)}…
        </dd>

        <dt>Chain hash</dt>
        <dd title={`SHA-256(previous ‖ body). Previous was ${e.prevHash.slice(0, 24)}…`}>
          {e.hash.slice(0, 24)}…
        </dd>
      </dl>

      <div className="tl-payload-label">Signed payload</div>
      <div className="tl-payload">{JSON.stringify(e.payload, null, 2)}</div>
    </div>
  );
}

export default function PackageDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();

  // The picker is always present, so this screen is a destination in its own
  // right rather than something only reachable by knowing to click a table row.
  const list = useAsync(() => api.packages(), []);
  const pkg = useAsync(
    () => (id ? api.package(id) : Promise.resolve(null)),
    [id],
    { pollMs: 15_000 },
  );

  const picker = (
    <div className="toolbar">
      <label htmlFor="pkg">Package</label>
      <select
        id="pkg"
        value={id ?? ""}
        onChange={(e) => nav(e.target.value ? `/workflow/${e.target.value}` : "/workflow")}
        style={{ minWidth: 300 }}
      >
        <option value="">Select a package…</option>
        {(list.data?.packages ?? []).map((x) => (
          <option key={x.id} value={x.id}>
            {x.centreCode} — {x.examName}
            {x.anomalyCount > 0 ? `  (${x.anomalyCount} finding${x.anomalyCount > 1 ? "s" : ""})` : ""}
          </option>
        ))}
      </select>
      <div className="spacer" />
      <Link to="/packages" className="btn">All packages</Link>
    </div>
  );

  if (pkg.error) return <><ErrorNote error={pkg.error} />{picker}</>;

  if (!id) {
    return (
      <>
        {picker}
        <Card>
          <Empty>
            Choose a package to see its complete workflow — every event in order, who
            handled it, on which device, where they were standing, and the exact signed
            payload behind each step.
          </Empty>
        </Card>
      </>
    );
  }

  if (!pkg.data) return <>{picker}<Card><Empty>Loading the custody record…</Empty></Card></>;

  const p = pkg.data;

  // Workflow at a glance. Each stage is true because an event proves it, never
  // because a column says so.
  const stages = [
    { label: "Sealed", done: p.timeline.some((e) => e.kind === "PACKAGE_SEALED") },
    { label: "Seal fitted", done: p.timeline.some((e) => e.kind === "SEAL_APPLIED") },
    { label: "Dispatched", done: p.projection.hops.some((h) => h.state === "in_transit") },
    { label: "At custodian", done: p.projection.hops.some((h) => h.state === "at_custodian") },
    { label: "At centre", done: p.projection.hops.some((h) => h.state === "at_centre") },
    { label: "Access granted", done: p.projection.accessGranted },
    { label: "Printed", done: p.projection.printed },
    { label: "Key destroyed", done: p.projection.keyDestroyed },
  ];

  return (
    <>
      {picker}

      {p.observedState === "compromised" && (
        <div className="banner">
          This package is presumed compromised. Per the field-ops runbook it must not be
          printed, and the authority and police must be notified.
        </div>
      )}

      {p.divergent && (
        <div className="note">
          <strong>Plan and reality disagree.</strong> The plan records this package as{" "}
          <em>{p.declaredState.replace(/_/g, " ")}</em>, but its events prove{" "}
          <em>{p.observedState.replace(/_/g, " ")}</em>. The ledger is never edited to match the
          plan — this divergence is itself the finding.
        </div>
      )}

      <Card
        title="Workflow"
        hint={`${stages.filter((s) => s.done).length} of ${stages.length} stages reached`}
      >
        <div className="stages">
          {stages.map((s) => (
            <div key={s.label} className={`stage${s.done ? " done" : ""}`}>
              <span className="stage-mark">{s.done ? "✓" : "·"}</span>
              {s.label}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid main-side" style={{ marginTop: 14 }}>
        <Card
          title="Event timeline"
          hint={`${p.timeline.length} events, oldest first — every field the ledger holds`}
        >
          {p.timeline.length === 0 ? (
            <Empty>No events recorded against this package.</Empty>
          ) : (
            <div className="timeline">
              {p.timeline.map((e) => {
                const hop = p.projection.hops.find((h) => h.seq === e.seq);
                return <Event key={e.seq} e={e} {...(hop ? { hop } : {})} />;
              })}
            </div>
          )}
        </Card>

        <div style={{ display: "grid", gap: 14 }}>
          <Card title={p.centreCode} hint={p.examName}>
            <dl className="kv">
              <dt>Observed</dt>
              <dd><StateBadge state={p.observedState} /></dd>
              <dt>Declared</dt>
              <dd><span className="badge neutral">{p.declaredState.replace(/_/g, " ")}</span></dd>
              <dt>Risk</dt>
              <dd><RiskMeter score={p.riskScore} /></dd>
              <dt>Holder</dt>
              <dd>{p.projection.holderRole?.replace(/_/g, " ") ?? "—"}</dd>
              <dt>Seal</dt>
              <dd>{p.sealSerial ?? "—"}</dd>
              <dt>Copies</dt>
              <dd>{p.copies}</dd>
              <dt>Events</dt>
              <dd>{p.eventCount}</dd>
              <dt>Window</dt>
              <dd style={{ fontSize: 11 }}>
                {p.custodyFrom ? formatTime(p.custodyFrom) : "—"}
                <br />→ {p.custodyTo ? formatTime(p.custodyTo) : "—"}
              </dd>
            </dl>

            <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
              <span className={`badge ${p.projection.accessGranted ? "ok" : "info"}`}>
                {p.projection.accessGranted ? "access granted" : "no grant"}
              </span>
              <span className={`badge ${p.projection.printed ? "ok" : "info"}`}>
                {p.projection.printed ? "printed" : "not printed"}
              </span>
              <span
                className={`badge ${
                  p.projection.keyDestroyed ? "ok" : p.projection.printed ? "critical" : "info"
                }`}
              >
                {p.projection.keyDestroyed ? "key zeroised" : "key not zeroised"}
              </span>
            </div>
          </Card>

          <Card title="Findings" hint={`${p.projection.anomalies.length} from replaying the chain`}>
            {p.projection.anomalies.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--ok)" }}>
                No anomalies. Every hop is accounted for and the lifecycle was respected.
              </div>
            ) : (
              p.projection.anomalies.map((a, i) => {
                const d = describe(a);
                return (
                  <div className="anomaly" key={i}>
                    <div>
                      <div className="code">{a.code}</div>
                      <div className="what">{d.what}</div>
                      <div className="why">{d.why}</div>
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
