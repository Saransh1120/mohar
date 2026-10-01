import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type OverrideRate, type OverrideRequest } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import { roleText } from "../components/CheckList";

/**
 * ── Override approval ────────────────────────────────────────────────────────
 *
 * A seam label that will not scan stops a hand-off. The officer photographs it
 * and types the seam id printed on it, and the request lands here. Two
 * operators, each signed in as themselves, each state that they saw the packet
 * and both officers on live video, and approve or refuse.
 *
 * What this page cannot do is see that video. There is no field app to place
 * the call from and no call is carried here: the operator makes it by whatever
 * line exists, and what is recorded is that a named operator said they saw it.
 * That is weaker than a recording, and the page says so rather than showing a
 * video frame that is not there.
 *
 * Underneath is how often the override is used, by centre, route and officer.
 * A label failing is ordinary. One centre's labels failing five times as often
 * as everyone else's is something to look at.
 */

const STATUS_BADGE: Record<OverrideRequest["standing"]["status"], string> = {
  pending: "info",
  approved: "ok",
  refused: "critical",
  unusable: "neutral",
};

export default function Overrides() {
  const overrides = useAsync(() => api.overrides(), [], { pollMs: 5_000 });
  const stats = useAsync(() => api.overrideStats(), [], { pollMs: 15_000 });
  const list = overrides.data?.overrides ?? [];
  const pending = list.filter((o) => o.standing.status === "pending").length;

  const refresh = () => {
    void overrides.refresh();
    void stats.refresh();
  };

  if (overrides.error) return <ErrorNote error={overrides.error} />;

  return (
    <>
      <div className="note">
        A label that will not scan is also what a swapped label looks like, so this is{" "}
        <strong>a recorded override, not a bypass</strong>. It needs <strong>two operators</strong>,
        each signed in as themselves, each stating they saw the packet and both field officers on
        live video. Once approved it stands in for the scan on that one leg, every other check on
        the leg still runs, and the packet is flagged for inspection where it arrives. A request is
        made from the <Link to="/transfers">Transfers</Link> console by choosing a damaged label.
      </div>

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {list.length} request{list.length === 1 ? "" : "s"} · {pending} awaiting a decision
        </span>
        <div className="spacer" />
        <button onClick={refresh}>Refresh</button>
      </div>

      <div className="grid main-side">
        <Card title="Requests" hint="newest first" flush>
          {list.length === 0 ? (
            <Empty>No damaged label has been reported.</Empty>
          ) : (
            list.map((o) => <RequestRow key={o.id} request={o} onDecided={refresh} />)
          )}
        </Card>

        <div style={{ display: "grid", gap: 14 }}>
          <Card title="How often it is used" hint="approved overrides per 100 legs">
            {stats.error ? (
              <ErrorNote error={stats.error} />
            ) : !stats.data ? (
              <Empty>Counting…</Empty>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
                  Across everything: <strong className="mono">{stats.data.baseline.overrides}</strong> of{" "}
                  <span className="mono">{stats.data.baseline.legs}</span> legs,{" "}
                  <span className="mono">{stats.data.baseline.per100}</span> per 100. Each row below is
                  measured against that.
                </div>
                <RateTable title="By centre" rows={stats.data.byCentre} />
                <RateTable title="By route" rows={stats.data.byRoute} />
                <RateTable title="By officer" rows={stats.data.byOfficer} />
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function RateTable({ title, rows }: { title: string; rows: OverrideRate[] }) {
  const used = rows.filter((r) => r.overrides > 0);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {title}
      </div>
      {used.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-faint)", padding: "6px 0" }}>
          No overrides among {rows.length} with legs on record.
        </div>
      ) : (
        <table>
          <tbody>
            {used.slice(0, 8).map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="num mono">
                  {r.overrides} of {r.legs}
                </td>
                <td className="num mono">{r.per100} / 100</td>
                <td className="num mono">{r.timesBaseline === null ? "—" : `${r.timesBaseline}× overall`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RequestRow({ request: o, onDecided }: { request: OverrideRequest; onDecided: () => void }) {
  const { account } = useAuth();
  const [video, setVideo] = useState(false);
  const [officers, setOfficers] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mine = account ? o.decisions.find((d) => d.accountUsername === account.username) : undefined;
  const open = o.standing.status === "pending";

  async function decide(decision: "approved" | "refused") {
    setBusy(true);
    setErr(null);
    try {
      await api.decideOverride(o.id, {
        decision,
        videoConfirmed: video,
        officersPresent: officers,
        note,
      });
      setNote("");
      onDecided();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`act${open ? " undecided" : ""}`}>
      <div className="act-head" style={{ cursor: "default" }}>
        <div className="act-main">
          <div className="act-title">
            <span className="act-name">Label would not scan</span>
            <span className={`badge ${STATUS_BADGE[o.standing.status]}`}>{o.standing.status}</span>
            {o.used && <span className="badge neutral">used on its leg</span>}
          </div>

          <div className="act-who">
            <span className="mono">{o.seal_serial ?? "no serial"}</span>
            <span className="dim"> · {o.centre_code}</span>
            <span className="dim">
              {" "}
              · leg {o.leg_no}: {o.from_place} → {o.to_place}
            </span>
          </div>

          <ul className="act-facts">
            <li>
              Reported by {o.person_name ? `${o.person_name} (${roleText(o.person_role ?? "")})` : "an officer not on record"}
              , after {o.attempted_seconds}s of trying; code{o.which_codes === "both" ? "s A and B" : ` ${o.which_codes}`}{" "}
              unreadable
            </li>
            <li>
              Seam id typed off the label: <span className="mono">{o.seam_id_typed}</span> —{" "}
              {o.evidence.seamIdMatches
                ? "the one recorded for this packet"
                : "NOT the one recorded for this packet"}
            </li>
            {o.evidence.serialMatches !== undefined && (
              <li>
                Serial typed: <span className="mono">{o.serial_typed}</span> —{" "}
                {o.evidence.serialMatches ? "matches" : "does not match"} the packet's
              </li>
            )}
            <li>
              Photograph committed: sha256 <span className="mono">{o.photo_sha256.slice(0, 24)}…</span>
            </li>
          </ul>

          <div className="act-consequence">{o.standing.detail.charAt(0).toUpperCase() + o.standing.detail.slice(1)}.</div>

          {o.decisions.length > 0 && (
            <div className="alert-acks">
              {o.decisions.map((d) => (
                <div key={d.accountId} className="alert-ack">
                  <span className="who">{d.accountName}</span>
                  <span className="mono"> · {d.accountUsername}</span>
                  <span>
                    {" "}
                    · {d.decision}
                    {d.decision === "approved" && " over live video, both officers present"}
                  </span>
                  <span title={formatTime(d.decidedAt)}> · {relativeTime(d.decidedAt)}</span>
                  <div className="alert-ack-note">{d.note}</div>
                </div>
              ))}
            </div>
          )}

          {open &&
            (!account ? (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>Sign in to decide.</div>
            ) : mine ? (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
                You have decided this request. The second decision has to come from a second operator,
                signed in as themselves.
              </div>
            ) : (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
                  <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} /> I saw
                  this packet and its label on a live video call
                </label>
                <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
                  <input type="checkbox" checked={officers} onChange={(e) => setOfficers(e.target.checked)} />{" "}
                  Both field officers were on the call
                </label>
                <div className="alert-ack-form">
                  <textarea
                    value={note}
                    placeholder="What was seen, or why it is refused"
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                  />
                  <button
                    className="primary"
                    disabled={busy || note.trim().length < 3 || !video || !officers}
                    onClick={() => void decide("approved")}
                  >
                    {busy ? "…" : "Approve"}
                  </button>
                  <button disabled={busy || note.trim().length < 3} onClick={() => void decide("refused")}>
                    Refuse
                  </button>
                </div>
              </div>
            ))}
          {err && <div className="banner" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
        </div>

        <div className="act-side">
          <div className="act-time" title={formatTime(o.requested_at)}>
            {relativeTime(o.requested_at)}
          </div>
          <div className="act-ref mono">{o.id.slice(0, 8)}</div>
        </div>
      </div>
    </div>
  );
}
