import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, relativeTime, formatTime } from "../lib/hooks";
import { Card, Stat, Empty, ErrorNote, StateBadge, RiskMeter } from "../components/ui";
import { KeyBadge } from "../components/KeyBadge";
import CentreMap from "../components/CentreMap";

export default function Dashboard() {
  const nav = useNavigate();
  const summary = useAsync(() => api.summary(), [], { pollMs: 10_000 });
  const packages = useAsync(() => api.packages(), [], { pollMs: 15_000 });
  const centres = useAsync(() => api.centres(), []);
  const epoch = useAsync(() => api.epoch(), [], { pollMs: 30_000 });
  const undecided = useAsync(
    () => api.activity({ requiresDecision: true, limit: 8 }),
    [],
    { pollMs: 12_000 },
  );
  const refusals = useAsync(
    () => api.activity({ onlyDenied: true, limit: 8 }),
    [],
    { pollMs: 12_000 },
  );

  if (summary.error) return <ErrorNote error={summary.error} />;

  const s = summary.data;
  const pkgs = packages.data?.packages ?? [];
  const states = s?.packagesByState ?? {};
  const inFlight =
    (states.in_transit ?? 0) + (states.at_custodian ?? 0) + (states.at_centre ?? 0);

  const attention = [...pkgs]
    .filter((p) => p.riskScore > 0 || p.divergent)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  const mins = epoch.data ? Math.floor(epoch.data.secondsRemaining / 60) : null;

  return (
    <>
      {/*
        One flat tile style across all four. Only the numeral and a 2px edge
        carry tone, and the third line is a mono fragment rather than a sentence
        — the long-form explanation moves into each tile's tooltip.
      */}
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat
          label="Awaiting a decision"
          value={s?.actsRequiringDecision ?? "—"}
          caption={s?.actsRequiringDecision ? "unresolved" : "all clear"}
          detail="Recorded acts whose consequences nobody has resolved — overrides, seal mismatches, fallback invocations."
          tone={s?.actsRequiringDecision ? "critical" : "ok"}
        />
        <Stat
          label="Access refused"
          value={s?.access.denied ?? 0}
          caption={`${s?.access.granted ?? 0} granted · ${s?.keyDenials ?? 0} on key`}
          detail={`${s?.access.denied ?? 0} refused and ${s?.access.granted ?? 0} granted by the policy engine. ${s?.keyDenials ?? 0} refusal(s) failed on the custody key itself.`}
          tone={s?.keyDenials ? "high" : "ok"}
        />
        <Stat
          label="Packages in flight"
          value={inFlight}
          caption={`${states.opened ?? 0} opened · ${states.compromised ?? 0} compromised`}
          detail="In transit, at a custodian, or at a centre — packages that have left the authority and are not yet opened."
        />
        <Stat
          label="Keys rotate in"
          value={mins !== null ? `${mins}m` : "—"}
          caption={epoch.data ? `epoch ${epoch.data.epoch} · ${s?.keys.active ?? 0} valid` : ""}
          detail="Custody keys are scoped to a six-hour epoch and expire by arithmetic on the clock, not by a scheduled job."
          tone="ok"
        />
      </div>

      <div className="grid main-side">
        <div style={{ display: "grid", gap: 14 }}>
          <Card title="Centres" hint="marked by the worst package at each centre" flush>
            {centres.data && centres.data.centres.length > 0 ? (
              <CentreMap
                centres={centres.data.centres}
                packages={pkgs}
                onSelect={(id) => nav(`/workflow/${id}`)}
              />
            ) : (
              <Empty>No centres registered. Run the seed tool to create a pilot exam.</Empty>
            )}
          </Card>

          <Card
            title="Awaiting a decision"
            hint="acts whose consequences nobody has resolved"
            actions={<Link to="/activity" className="btn">Open activity</Link>}
            flush
          >
            {undecided.data?.activity.length ? (
              undecided.data.activity.map((e) => (
                <div key={e.ref} className="act undecided">
                  <div className="act-head" style={{ cursor: "default" }}>
                    <div className="act-main">
                      <div className="act-title">
                        <span className="act-name">{e.act}</span>
                        <span className="act-kind mono">{e.kind}</span>
                      </div>
                      <div className="act-who">
                        {e.actorPerson ?? "unattributed"}
                        {e.actorRole && <span className="dim"> · {e.actorRole}</span>}
                        {e.centreCode && <span className="dim"> · {e.centreCode}</span>}
                      </div>
                      {e.consequence && <div className="act-consequence">{e.consequence}</div>}
                    </div>
                    <div className="act-side">
                      <KeyBadge
                        status={e.key.status}
                        fingerprint={e.key.fingerprint}
                        epochPresented={e.key.epochPresented}
                        epochCurrent={e.key.epochCurrent}
                      />
                      <div className="act-time" title={formatTime(e.at)}>
                        {relativeTime(e.at)}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <Empty>Nothing outstanding. Every recorded act has been accounted for.</Empty>
            )}
          </Card>

          <Card title="Packages needing attention" hint="ranked by custody risk" flush>
            {attention.length === 0 ? (
              <Empty>
                {pkgs.length === 0 ? "No packages yet." : "Every package is clean."}
              </Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Centre</th>
                    <th>Observed state</th>
                    <th>Risk</th>
                    <th>Findings</th>
                    <th>Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => nav(`/workflow/${p.id}`)}>
                      <td className="mono">{p.centreCode}</td>
                      <td>
                        <StateBadge state={p.observedState} />
                        {p.divergent && (
                          <span className="badge high" style={{ marginLeft: 6 }}>
                            diverged
                          </span>
                        )}
                      </td>
                      <td><RiskMeter score={p.riskScore} /></td>
                      <td>
                        {p.anomalyCount > 0 ? (
                          <span className="badge critical">{p.anomalyCount}</span>
                        ) : (
                          <span style={{ color: "var(--text-faint)" }}>—</span>
                        )}
                      </td>
                      <td className="mono" title={p.lastEventAt ? formatTime(p.lastEventAt) : ""}>
                        {p.lastEventAt ? relativeTime(p.lastEventAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <Card
          title="Recent refusals"
          hint="what the engine turned down, and why"
          actions={<Link to="/activity" className="btn">All</Link>}
          flush
        >
          {refusals.data?.activity.length ? (
            refusals.data.activity.map((e) => (
              <div key={e.ref} className="act denied">
                <div className="act-head" style={{ cursor: "default", padding: "11px 14px" }}>
                  <div className="act-main">
                    <div className="act-title">
                      <span className="act-name">{e.act}</span>
                      {e.stage && <span className="act-stage">{e.stage}</span>}
                    </div>
                    <div className="act-who">
                      {e.centreCode ?? "—"}
                      {e.actorPerson && <span className="dim"> · {e.actorPerson}</span>}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <KeyBadge
                        status={e.key.status}
                        fingerprint={e.key.fingerprint}
                        epochPresented={e.key.epochPresented}
                        epochCurrent={e.key.epochCurrent}
                      />
                    </div>
                    <div className="chips" style={{ marginTop: 6 }}>
                      {e.denyReasons.map((r) => (
                        <span className="chip fail" key={r}>{r}</span>
                      ))}
                    </div>
                    <div className="act-time" style={{ marginTop: 8 }} title={formatTime(e.at)}>
                      {relativeTime(e.at)}
                    </div>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <Empty>No refusals recorded.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
