import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Alert } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";

/**
 * ── Alerts ───────────────────────────────────────────────────────────────────
 *
 * Every row in led.alert, newest first. An alert states what happened and what
 * was known when it was raised; it carries no severity word, because a colour
 * that says "medium" teaches a control room which alerts it may leave.
 *
 * Nothing on this page edits an alert. Acknowledging one adds a row naming the
 * operator and what they did, and the alert itself stays as it was raised. What
 * has happened since — the late leg closing after all — is shown separately,
 * read live, so "what we knew then" and "what we know now" never merge.
 */

const TITLES: Record<string, string> = {
  LEG_OVERDUE: "Hand-off not completed in time",
  TRANSFER_ATTEMPTS_EXHAUSTED: "Three wrong serial or key entries on one leg",
};

const role = (r: string) => r.replace(/_/g, " ");

function str(e: Record<string, unknown>, k: string): string | null {
  const v = e[k];
  return typeof v === "string" ? v : null;
}

function num(e: Record<string, unknown>, k: string): number | null {
  const v = e[k];
  return typeof v === "number" ? v : null;
}

function duration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The evidence as sentences. Unknown kinds fall back to the raw fields. */
function facts(a: Alert): string[] {
  const e = a.evidence;
  const out: string[] = [];

  if (a.kind === "LEG_OVERDUE") {
    const expectedBy = str(e, "expectedBy");
    const late = num(e, "overdueBySeconds");
    if (expectedBy) {
      out.push(
        `Expected by ${formatTime(expectedBy)}` +
          (late !== null ? `; the watchdog found it open ${duration(late)} after that` : ""),
      );
    }
    const stage = str(e, "stage");
    const dispatchedAt = str(e, "dispatchedAt");
    const keyAt = str(e, "keyReleasedAt");
    if (stage === "not_dispatched") out.push("Nobody dispatched this leg");
    if (stage === "dispatched" && dispatchedAt) {
      out.push(`Dispatched ${formatTime(dispatchedAt)}; nobody accepted it`);
    }
    if (stage === "key_released" && keyAt) {
      out.push(`Receiver passed every check ${formatTime(keyAt)}; the key was never submitted`);
    }
    const lv = e["lastVerified"];
    if (lv && typeof lv === "object") {
      const v = lv as Record<string, unknown>;
      const at = str(v, "at");
      out.push(
        `Last verified with the packet: ${str(v, "name") ?? "unknown"} ` +
          `(${role(str(v, "role") ?? "")}), ${str(v, "step") ?? ""} of leg ${num(v, "legNo") ?? "?"}` +
          (at ? `, ${formatTime(at)}` : ""),
      );
    } else {
      out.push("No hand-off of this packet was verified before the alert");
    }
    const refused = num(e, "refusedAttempts");
    if (refused) out.push(`${refused} refused attempt${refused === 1 ? "" : "s"} on this leg`);
    return out;
  }

  if (a.kind === "TRANSFER_ATTEMPTS_EXHAUSTED") {
    const step = str(e, "step");
    const attemptNo = num(e, "attemptNo");
    if (step) out.push(`Refused at ${step}${attemptNo !== null ? `, attempt ${attemptNo}` : ""}`);
    const reasons = e["denyReasons"];
    if (Array.isArray(reasons) && reasons.length > 0) {
      out.push(`Refused for: ${reasons.join(", ")}`);
    }
    out.push("Further attempts on this leg are refused");
    return out;
  }

  for (const [k, v] of Object.entries(e)) {
    out.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return out;
}

type Filter = "open" | "all";

export default function Alerts() {
  const [filter, setFilter] = useState<Filter>("open");
  const alerts = useAsync(() => api.alerts({ open: filter === "open" }), [filter], {
    pollMs: 5_000,
  });
  const summary = useAsync(() => api.alertSummary(), [], { pollMs: 5_000 });
  const list = alerts.data?.alerts ?? [];

  const refresh = () => {
    void alerts.refresh();
    void summary.refresh();
  };

  return (
    <>
      <div className="note">
        An alert says what happened and what was known when it was raised. It is never edited:
        acknowledging one adds a record of <strong>who looked and what they did</strong>, and the
        alert stays exactly as it was raised. A hand-off that misses its expected time is raised
        here by the watchdog within a minute, with nobody having to notice it first.
      </div>

      <div className="toolbar">
        <div className="segmented">
          {(
            [
              ["open", "Awaiting acknowledgement"],
              ["all", "All alerts"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`seg${filter === k ? " active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {summary.data
            ? `${summary.data.total} raised · ${summary.data.unacknowledged} not acknowledged`
            : ""}
        </span>
        <div className="spacer" />
        <button onClick={refresh}>Refresh</button>
      </div>

      <Card flush>
        {alerts.error ? (
          <ErrorNote error={alerts.error} />
        ) : list.length === 0 ? (
          <Empty>
            {filter === "open"
              ? "Every alert has been acknowledged."
              : "No alerts have been raised. A late hand-off or repeated wrong entries on a leg will appear here."}
          </Empty>
        ) : (
          list.map((a) => <AlertRow key={a.id} alert={a} onAcked={refresh} />)
        )}
      </Card>
    </>
  );
}

function AlertRow({ alert: a, onAcked }: { alert: Alert; onAcked: () => void }) {
  const { account } = useAuth();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const acked = a.acks.length > 0;

  async function acknowledge() {
    setBusy(true);
    setErr(null);
    try {
      await api.ackAlert(a.id, note);
      setNote("");
      onAcked();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const closedAfter =
    a.leg_closed_at && Date.parse(a.leg_closed_at) > Date.parse(a.raised_at)
      ? Date.parse(a.leg_closed_at) - Date.parse(a.raised_at)
      : null;

  return (
    <div className={`act${a.requires_decision && !acked ? " undecided" : ""}${acked ? " acked" : ""}`}>
      <div className="act-head" style={{ cursor: "default" }}>
        <div className="act-main">
          <div className="act-title">
            <span className="act-name">{TITLES[a.kind] ?? role(a.kind.toLowerCase())}</span>
            <span className="act-kind mono">{a.kind}</span>
          </div>

          <div className="act-who">
            <span className="mono">{a.seal_serial ?? "no packet"}</span>
            {a.centre_code && <span className="dim"> · {a.centre_code}</span>}
            {a.leg_no !== null && (
              <span className="dim">
                {" "}
                · leg {a.leg_no}: {a.from_place} → {a.to_place}
                {a.from_role && a.to_role && ` (${role(a.from_role)} → ${role(a.to_role)})`}
              </span>
            )}
          </div>

          <ul className="act-facts">
            {facts(a).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>

          <div className="act-consequence">
            {a.requires_decision && <strong>Requires a decision. </strong>}
            {a.consequence}
          </div>

          {a.leg_closed_at && (
            <div className="alert-since">
              Since then: the leg closed {formatTime(a.leg_closed_at)}
              {closedAfter !== null && `, ${duration(closedAfter / 1000)} after this alert was raised`}.
              The alert stays on record as it was raised.
            </div>
          )}

          {acked && (
            <div className="alert-acks">
              {a.acks.map((k) => (
                <div key={k.id} className="alert-ack">
                  <span className="who">
                    {k.personName ?? k.accountName ?? "unknown"}
                  </span>
                  {k.accountUsername && <span className="mono"> · {k.accountUsername}</span>}
                  <span title={formatTime(k.ackedAt)}> · {relativeTime(k.ackedAt)}</span>
                  {k.note && <div className="alert-ack-note">{k.note}</div>}
                </div>
              ))}
            </div>
          )}

          {account ? (
            <div className="alert-ack-form">
              <textarea
                value={note}
                placeholder={acked ? "Add a further note" : "What was done or decided"}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
              />
              <button
                className={acked ? undefined : "primary"}
                disabled={busy || note.trim().length < 3}
                onClick={() => void acknowledge()}
              >
                {busy ? "…" : acked ? "Add note" : "Acknowledge"}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
              Sign in to acknowledge.
            </div>
          )}
          {err && <div className="banner" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
        </div>

        <div className="act-side">
          <div className="act-time" title={formatTime(a.raised_at)}>
            {relativeTime(a.raised_at)}
          </div>
          {a.leg_id && (
            <Link to="/transfers" style={{ fontSize: 11 }}>
              open Transfers
            </Link>
          )}
          <div className="act-ref mono">{a.id.slice(0, 8)}</div>
        </div>
      </div>
    </div>
  );
}
