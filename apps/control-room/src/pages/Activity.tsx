import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type ActivityEntry } from "../lib/api";
import { useAsync, formatTime, relativeTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import { KeyBadge } from "../components/KeyBadge";

/**
 * The activity ledger.
 *
 * Every recorded act, with the evidence attached. There are no severity labels
 * here by design: a word like "critical" tells an operator how to feel, and what
 * they need is what happened, who did it, which key they presented, whether it
 * verified, and where they were standing.
 */

function Row({ entry, expanded, onToggle }: {
  entry: ActivityEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const denied = entry.outcome === "denied";

  return (
    <div className={`act${denied ? " denied" : ""}${entry.requiresDecision ? " undecided" : ""}`}>
      <div className="act-head" onClick={onToggle}>
        <div className="act-main">
          <div className="act-title">
            <span className="act-name">{entry.act}</span>
            <span className="act-kind mono">{entry.kind}</span>
            {entry.stage && <span className="act-stage">stage: {entry.stage}</span>}
          </div>

          <div className="act-who">
            {entry.actorPerson ?? "unattributed"}
            {entry.actorRole && <span className="dim"> · {entry.actorRole}</span>}
            {entry.deviceKind && <span className="dim"> · {entry.deviceKind}</span>}
            {entry.centreCode && <span className="dim"> · {entry.centreCode}</span>}
          </div>

          <ul className="act-facts">
            {entry.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>

          {entry.consequence && (
            <div className="act-consequence">
              <strong>Requires a decision.</strong> {entry.consequence}
            </div>
          )}
        </div>

        <div className="act-side">
          <KeyBadge
            status={entry.key.status}
            fingerprint={entry.key.fingerprint}
            epochPresented={entry.key.epochPresented}
            epochCurrent={entry.key.epochCurrent}
          />
          <div className="act-time" title={formatTime(entry.at)}>
            {relativeTime(entry.at)}
          </div>
          <div className="act-ref mono">{entry.ref}</div>
        </div>
      </div>

      {expanded && (
        <div className="act-detail">
          <div className="detail-grid">
            <section>
              <h4>Key</h4>
              <p>{entry.key.detail}</p>
              {entry.key.epochCurrent !== null && (
                <dl className="kv">
                  <dt>Presented epoch</dt>
                  <dd>{entry.key.epochPresented ?? "—"}</dd>
                  <dt>Current epoch</dt>
                  <dd>{entry.key.epochCurrent}</dd>
                  <dt>Fingerprint</dt>
                  <dd>{entry.key.fingerprint ?? "—"}</dd>
                </dl>
              )}
            </section>

            {(entry.checksPassed.length > 0 || entry.denyReasons.length > 0) && (
              <section>
                <h4>
                  Checks — {entry.checksPassed.length} passed,{" "}
                  {entry.denyReasons.length} failed
                </h4>
                <div className="chips">
                  {entry.checksPassed.map((c) => (
                    <span className="chip pass" key={c}>{c}</span>
                  ))}
                  {entry.denyReasons.map((c) => (
                    <span className="chip fail" key={c}>{c}</span>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h4>Where and when</h4>
              <dl className="kv">
                <dt>Occurred</dt>
                <dd>{formatTime(entry.at)}</dd>
                <dt>Recorded</dt>
                <dd>{formatTime(entry.recordedAt)}</dd>
                {entry.clockSkewMs !== null && (
                  <>
                    <dt>Clock offset</dt>
                    <dd>{Math.round(entry.clockSkewMs / 1000)} s</dd>
                  </>
                )}
                {entry.position && (
                  <>
                    <dt>Position</dt>
                    <dd>
                      {entry.position.lat.toFixed(5)}, {entry.position.lon.toFixed(5)}
                    </dd>
                    {entry.position.accuracyM !== null && (
                      <>
                        <dt>Fix accuracy</dt>
                        <dd>±{Math.round(entry.position.accuracyM)} m</dd>
                      </>
                    )}
                    {entry.position.distanceM !== null && (
                      <>
                        <dt>From centre</dt>
                        <dd>{Math.round(entry.position.distanceM)} m</dd>
                      </>
                    )}
                  </>
                )}
                {entry.sealSerialRead && (
                  <>
                    <dt>Seal read</dt>
                    <dd>{entry.sealSerialRead}</dd>
                  </>
                )}
              </dl>
            </section>

            <section>
              <h4>Provenance</h4>
              <dl className="kv">
                <dt>Source</dt>
                <dd>{entry.source === "event" ? "signed ledger event" : "access attempt"}</dd>
                <dt>Device</dt>
                <dd style={{ fontSize: 10 }}>{entry.actorDeviceId ?? "—"}</dd>
                {entry.eventHash && (
                  <>
                    <dt>Chain hash</dt>
                    <dd style={{ fontSize: 10, wordBreak: "break-all" }}>{entry.eventHash}</dd>
                  </>
                )}
                {entry.examName && (
                  <>
                    <dt>Exam</dt>
                    <dd style={{ fontFamily: "var(--sans)" }}>{entry.examName}</dd>
                  </>
                )}
              </dl>
              {entry.packageId && (
                <Link to={`/packages/${entry.packageId}`} style={{ fontSize: 12 }}>
                  open package →
                </Link>
              )}
            </section>
          </div>

          {entry.payload != null && (
            <div>
              <h4 style={{ fontSize: 11, margin: "12px 0 6px", color: "var(--text-faint)" }}>
                Signed payload — the exact bytes the device's signature covers
              </h4>
              <pre className="tl-payload">{JSON.stringify(entry.payload, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Filter = "all" | "decisions" | "denied" | "undecided";

export default function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const [examId, setExamId] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const exams = useAsync(() => api.exams(), []);
  const activity = useAsync(
    () =>
      api.activity({
        limit: 300,
        ...(examId ? { examId } : {}),
        onlyDecisions: filter === "decisions" || filter === "denied",
        onlyDenied: filter === "denied",
        requiresDecision: filter === "undecided",
      }),
    [filter, examId],
    { pollMs: 12_000 },
  );

  if (activity.error) return <ErrorNote error={activity.error} />;
  const list = activity.data?.activity ?? [];

  const toggle = (ref: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  return (
    <>
      <div className="note">
        Every act, with its evidence. Access decisions carry the key that was presented and whether
        it verified; signed events carry the payload their device signature covers. Click any row
        for the full record.
      </div>

      <div className="toolbar">
        <div className="segmented">
          {(
            [
              ["all", "Everything"],
              ["decisions", "Access decisions"],
              ["denied", "Refusals only"],
              ["undecided", "Awaiting a decision"],
            ] as [Filter, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={filter === v ? "seg active" : "seg"}
              onClick={() => setFilter(v)}
            >
              {label}
            </button>
          ))}
        </div>

        <select value={examId} onChange={(e) => setExamId(e.target.value)}>
          <option value="">All exams</option>
          {exams.data?.exams.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <div className="spacer" />
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{list.length} acts</span>
        <button onClick={() => setOpen(new Set(list.map((e) => e.ref)))}>Expand all</button>
        <button onClick={() => setOpen(new Set())}>Collapse</button>
      </div>

      <Card flush>
        {list.length === 0 ? (
          <Empty>{activity.loading ? "Loading…" : "Nothing recorded under this filter."}</Empty>
        ) : (
          list.map((e) => (
            <Row key={e.ref} entry={e} expanded={open.has(e.ref)} onToggle={() => toggle(e.ref)} />
          ))
        )}
      </Card>
    </>
  );
}
