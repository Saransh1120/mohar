import { useState } from "react";
import { api, type ChainVerification } from "../lib/api";
import { useAsync, formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote, Stat } from "../components/ui";

export default function Integrity() {
  const anchors = useAsync(() => api.anchors(), []);
  const health = useAsync(() => api.health(), [], { pollMs: 15_000 });

  const [result, setResult] = useState<ChainVerification | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState("");

  async function verify() {
    setRunning(true);
    setErr(null);
    try {
      setResult(await api.verifyChain("0"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function buildAnchor() {
    setErr(null);
    try {
      await api.buildAnchor(day || undefined);
      await anchors.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (anchors.error) return <ErrorNote error={anchors.error} />;
  const list = anchors.data?.anchors ?? [];

  return (
    <>
      <div className="note">
        Tamper-evidence here comes from a hash chain plus external RFC 3161 timestamping, not from
        consensus — see <span className="mono">adr/0001-not-a-blockchain</span>. Verification
        recomputes every link locally, so it detects any edit to history without trusting the
        service that serves it.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Chain tip"
          value={health.data?.chainTip ? `#${health.data.chainTip.seq}` : "empty"}
          caption={health.data?.chainTip ? `${health.data.chainTip.hash.slice(0, 12)}…` : "no events yet"}
          {...(health.data?.chainTip ? { detail: health.data.chainTip.hash } : {})}
        />
        <Stat
          label="Published anchors"
          value={list.length}
          caption={`${list.filter((a) => a.notarised).length} notarised`}
          detail="Anchors carrying an RFC 3161 timestamp token from an external authority."
        />
        <Stat
          label="Last verification"
          value={result ? (result.intact ? "intact" : `${result.breaks.length} break(s)`) : "—"}
          caption={result ? `${result.checked} links` : "not run yet"}
          detail="Every link is recomputed locally, so an edit is detected without trusting the service that served the data."
          tone={result && !result.intact ? "critical" : "neutral"}
        />
      </div>

      <div className="grid cols-2">
        <Card
          title="Recompute the chain"
          hint="every link, from genesis"
          actions={
            <button className="primary" onClick={() => void verify()} disabled={running}>
              {running ? "Verifying…" : "Verify now"}
            </button>
          }
        >
          {!result ? (
            <Empty>
              Run a verification to recompute <span className="mono">SHA256(prev ‖ body)</span> for
              every event and compare it against what is stored.
            </Empty>
          ) : result.intact ? (
            <div>
              <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 500 }}>
                Chain intact across {result.checked} events.
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
                Sequence {result.fromSeq} → {result.toSeq}. Every recomputed hash matched the stored
                one, so nothing has been inserted, removed, or reordered.
              </div>
            </div>
          ) : (
            <div>
              <div style={{ color: "var(--critical)", fontWeight: 500, marginBottom: 10 }}>
                {result.breaks.length} break(s) found across {result.checked} events.
              </div>
              {result.breaks.map((b, i) => (
                <div className="anomaly" key={i}>
                  <div>
                    <div className="code">#{b.seq} · {b.reason}</div>
                    <div className="why" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      expected {b.expected.slice(0, 24)}…
                      <br />
                      actual&nbsp;&nbsp; {b.actual.slice(0, 24)}…
                    </div>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
                A run of breaks from one point onward suggests a rewrite attempt; a single isolated
                break suggests corruption.
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Merkle anchors"
          hint="one root per day"
          actions={
            <div style={{ display: "flex", gap: 6 }}>
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              <button onClick={() => void buildAnchor()}>Build</button>
            </div>
          }
          flush
        >
          {list.length === 0 ? (
            <Empty>
              No anchors yet. Building one computes the day's Merkle root and stores it; the RFC
              3161 timestamp is fetched separately and is not implemented yet.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Merkle root</th>
                  <th className="num">Tree size</th>
                  <th>Notarised</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.day}>
                    <td className="mono">{a.day}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {a.merkle_root.slice(0, 20)}…
                    </td>
                    <td className="num">{a.tree_size}</td>
                    <td>
                      {a.notarised ? (
                        <span className="badge ok">TSA token</span>
                      ) : (
                        <span className="badge medium" title="buildAnchor stores the root; no TSA client exists yet">
                          pending
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list.length > 0 && (
            <div style={{ padding: "10px 16px", fontSize: 11, color: "var(--text-faint)", borderTop: "1px solid var(--border)" }}>
              Last published {formatTime(list[0]!.published_at)}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
