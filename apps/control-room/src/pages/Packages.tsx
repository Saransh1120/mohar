import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type PackageState } from "../lib/api";
import { useAsync, relativeTime, formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote, StateBadge, RiskMeter } from "../components/ui";

type Sort = "risk" | "centre" | "recent";

export default function Packages() {
  const nav = useNavigate();
  const exams = useAsync(() => api.exams(), []);
  const [examId, setExamId] = useState<string>("");
  const [state, setState] = useState<string>("");
  const [sort, setSort] = useState<Sort>("risk");
  const [query, setQuery] = useState("");

  const packages = useAsync(
    () => api.packages(examId || undefined),
    [examId],
    { pollMs: 15_000 },
  );

  const rows = useMemo(() => {
    let list = packages.data?.packages ?? [];
    if (state) list = list.filter((p) => p.observedState === state);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.centreCode.toLowerCase().includes(q) ||
          (p.sealSerial ?? "").toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (sort === "centre") return a.centreCode.localeCompare(b.centreCode);
      if (sort === "recent")
        return Date.parse(b.lastEventAt ?? "0") - Date.parse(a.lastEventAt ?? "0");
      return b.riskScore - a.riskScore || a.centreCode.localeCompare(b.centreCode);
    });
  }, [packages.data, state, sort, query]);

  if (packages.error) return <ErrorNote error={packages.error} />;

  const STATES: PackageState[] = [
    "sealed", "in_transit", "at_custodian", "at_centre", "opened", "returned", "compromised",
  ];

  return (
    <>
      <div className="note">
        <strong>Declared</strong> is what the plan expects; <strong>observed</strong> is what the
        ledger's events actually prove. They are shown separately and never reconciled — a package
        whose reality has departed from its plan is flagged <em>diverged</em> rather than corrected.
      </div>

      <div className="toolbar">
        <label htmlFor="exam">Exam</label>
        <select id="exam" value={examId} onChange={(e) => setExamId(e.target.value)}>
          <option value="">All exams</option>
          {exams.data?.exams.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <label htmlFor="state">State</label>
        <select id="state" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any</option>
          {STATES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>

        <label htmlFor="sort">Sort</label>
        <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="risk">Risk (highest first)</option>
          <option value="centre">Centre code</option>
          <option value="recent">Most recent activity</option>
        </select>

        <input
          type="search"
          placeholder="Centre or seal serial…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 200 }}
        />

        <div className="spacer" />
        <button onClick={() => void packages.refresh()}>Refresh</button>
      </div>

      <Card flush>
        {rows.length === 0 ? (
          <Empty>
            {packages.loading ? "Loading…" : "No packages match these filters."}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Centre</th>
                <th>Exam</th>
                <th>Declared</th>
                <th>Observed</th>
                <th>Risk</th>
                <th>Findings</th>
                <th className="num">Copies</th>
                <th className="num">Events</th>
                <th>Seal</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/workflow/${p.id}`)}>
                  <td className="mono">{p.centreCode}</td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{p.examName}</td>
                  <td>
                    <span className="badge neutral">{p.declaredState.replace(/_/g, " ")}</span>
                  </td>
                  <td>
                    <StateBadge state={p.observedState} />
                    {p.divergent && (
                      <span
                        className="badge high"
                        style={{ marginLeft: 6 }}
                        title="The ledger disagrees with the plan"
                      >
                        diverged
                      </span>
                    )}
                  </td>
                  <td><RiskMeter score={p.riskScore} /></td>
                  <td>
                    {p.anomalyCount > 0 ? (
                      <span className="badge critical">{p.anomalyCount}</span>
                    ) : (
                      <span style={{ color: "var(--text-faint)" }}>clean</span>
                    )}
                  </td>
                  <td className="num">{p.copies}</td>
                  <td className="num">{p.eventCount}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {p.sealSerial ?? "—"}
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
    </>
  );
}
