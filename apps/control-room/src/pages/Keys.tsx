import { useEffect, useState } from "react";
import { api, type AccessKey, type AccessDecisionResult } from "../lib/api";
import { useAsync, formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote, Stat } from "../components/ui";

/** Live countdown to the next rotation, ticking locally between polls. */
function EpochClock({ endsAt, epoch }: { endsAt: string; epoch: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(endsAt) - now) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pct = Math.min(100, Math.max(0, ((21600 - left) / 21600) * 100));

  return (
    <div>
      <div className="epoch-clock mono">
        {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
      </div>
      <div className="epoch-bar">
        <div className="epoch-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="epoch-foot">
        epoch {epoch} · every key expires at {formatTime(endsAt)}
      </div>
    </div>
  );
}

export default function Keys() {
  const packages = useAsync(() => api.packages(), []);
  const stages = useAsync(() => api.stages(), []);
  const persons = useAsync(() => api.persons(), []);
  const devices = useAsync(() => api.devices(), []);
  const keys = useAsync(() => api.keys(), [], { pollMs: 20_000 });

  const [issued, setIssued] = useState<AccessKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ packageId: "", stage: "unlock", personId: "" });

  // Live test harness — submit a real request to the engine and see the ruling.
  const [test, setTest] = useState({ packageId: "", stage: "unlock", key: "", deviceId: "", personId: "", seal: "" });
  const [decision, setDecision] = useState<AccessDecisionResult | null>(null);

  async function issue() {
    if (!form.packageId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.issueKey(form.packageId, form.stage, form.personId || undefined);
      setIssued(r.key);
      await keys.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rotateKeys();
      await keys.refresh();
      setErr(`Rotated epoch ${r.epoch}: ${r.issuedCount} issued, ${r.alreadyCurrent} already current.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setErr(null);
    setDecision(null);
    try {
      const pkg = packages.data?.packages.find((p) => p.id === test.packageId);
      const centre = pkg
        ? (await api.centres()).centres.find((c) => c.id === pkg.centreId)
        : undefined;
      setDecision(
        await api.requestAccess({
          packageId: test.packageId,
          stage: test.stage,
          ...(test.key ? { presentedKey: test.key } : {}),
          deviceId: test.deviceId,
          ...(test.personId ? { personId: test.personId } : {}),
          ...(test.seal ? { sealSerialRead: test.seal } : {}),
          ...(centre ? { geo: { lat: centre.lat, lon: centre.lon, accuracyM: 8 } } : {}),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (keys.error) return <ErrorNote error={keys.error} />;

  const list = keys.data?.keys ?? [];
  const ep = keys.data?.epoch;
  const active = list.filter((k) => !k.revokedAt && Date.parse(k.validTo) > Date.now());

  return (
    <>
      <div className="note">
        Every stage of custody requires its own key, valid for one six-hour epoch. Expiry is
        arithmetic on the clock, not a scheduled job — if rotation never runs, keys stop working
        rather than keeping working. <strong>A key is shown exactly once, when it is issued.</strong>{" "}
        Only its SHA-256 is stored, so it cannot be recovered afterwards.
      </div>

      {err && <div className="banner" style={{ borderColor: "var(--accent)", color: "var(--text)" }}>{err}</div>}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Card title="Next rotation" flush>
          <div style={{ padding: "14px 16px" }}>
            {ep ? <EpochClock endsAt={ep.endsAt} epoch={ep.epoch} /> : "—"}
          </div>
        </Card>
        <Stat
          label="Keys valid now"
          value={active.length}
          caption={`${list.length} issued total`}
          detail="Keys inside their epoch window and not revoked."
          tone="ok"
        />
        <Stat
          label="Revoked"
          value={list.filter((k) => k.revokedAt).length}
          caption="burned early"
          detail="Keys revoked before their epoch expired — the holder changed, or the key was suspected copied."
          tone={list.some((k) => k.revokedAt) ? "critical" : "neutral"}
        />
        <Card flush>
          <div style={{ padding: "14px 16px" }}>
            <div className="label" style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Rotate now
            </div>
            <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void rotate()}>
              Issue this epoch's keys
            </button>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>
              Idempotent — packages already holding a key for this epoch are skipped.
            </div>
          </div>
        </Card>
      </div>

      {issued?.key && (
        <Card title="Key issued — copy it now" hint="this is the only time it will be shown">
          <div className="key-reveal mono">{issued.key}</div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Stage</dt><dd>{issued.stage}</dd>
            <dt>Epoch</dt><dd>{issued.epoch}</dd>
            <dt>Fingerprint</dt><dd>{issued.fingerprint}</dd>
            <dt>Valid until</dt><dd>{formatTime(issued.validTo)}</dd>
          </dl>
          <button style={{ marginTop: 12 }} onClick={() => setIssued(null)}>Dismiss</button>
        </Card>
      )}

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Issue a key" hint="for one stage of one package">
          <div className="form">
            <label>Package</label>
            <select value={form.packageId} onChange={(e) => setForm({ ...form, packageId: e.target.value })}>
              <option value="">Select…</option>
              {packages.data?.packages.map((p) => (
                <option key={p.id} value={p.id}>{p.centreCode} — {p.examName}</option>
              ))}
            </select>

            <label>Stage</label>
            <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              {stages.data?.stages.map((s) => (
                <option key={s.stage} value={s.stage}>
                  {s.ordinal}. {s.stage} — {s.expectedRole}
                </option>
              ))}
            </select>

            <label>Issue to</label>
            <select value={form.personId} onChange={(e) => setForm({ ...form, personId: e.target.value })}>
              <option value="">Unassigned</option>
              {persons.data?.persons.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName} ({p.role})</option>
              ))}
            </select>
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy || !form.packageId} onClick={() => void issue()}>
            Issue key
          </button>
        </Card>

        <Card
          title="Test the engine"
          hint="submits a real request; the attempt is recorded either way"
        >
          <div className="form">
            <label>Package</label>
            <select value={test.packageId} onChange={(e) => setTest({ ...test, packageId: e.target.value })}>
              <option value="">Select…</option>
              {packages.data?.packages.map((p) => (
                <option key={p.id} value={p.id}>{p.centreCode}</option>
              ))}
            </select>

            <label>Stage</label>
            <select value={test.stage} onChange={(e) => setTest({ ...test, stage: e.target.value })}>
              {stages.data?.stages.map((s) => (
                <option key={s.stage} value={s.stage}>{s.stage}</option>
              ))}
            </select>

            <label>Device</label>
            <select value={test.deviceId} onChange={(e) => setTest({ ...test, deviceId: e.target.value })}>
              <option value="">Select…</option>
              {devices.data?.devices.filter((d) => !d.revokedAt).map((d) => (
                <option key={d.id} value={d.id}>{d.kind} · {d.id.slice(0, 8)}</option>
              ))}
            </select>

            <label>Person</label>
            <select value={test.personId} onChange={(e) => setTest({ ...test, personId: e.target.value })}>
              <option value="">None</option>
              {persons.data?.persons.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName} ({p.role})</option>
              ))}
            </select>

            <label>Key</label>
            <input
              type="text"
              placeholder="MHR-UNLOCK-…  (leave blank to test a missing key)"
              value={test.key}
              onChange={(e) => setTest({ ...test, key: e.target.value })}
            />

            <label>Seal read</label>
            <input
              type="text"
              placeholder="SEAL-…"
              value={test.seal}
              onChange={(e) => setTest({ ...test, seal: e.target.value })}
            />
          </div>
          <button
            className="primary"
            style={{ marginTop: 12 }}
            disabled={busy || !test.packageId || !test.deviceId}
            onClick={() => void runTest()}
          >
            Submit request
          </button>

          {decision && (
            <div style={{ marginTop: 14 }}>
              <div className={decision.outcome === "granted" ? "verdict granted" : "verdict denied"}>
                {decision.outcome === "granted" ? "GRANTED" : "REFUSED"}
                <span style={{ opacity: 0.75, fontWeight: 400, marginLeft: 8 }}>
                  {decision.checksPassed.length}/{decision.checks.length} checks passed
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                {decision.checks.map((c) => (
                  <div key={c.check} className={`check ${c.passed ? "pass" : "fail"}`}>
                    <span className="check-name mono">{c.check}</span>
                    <span className="check-evidence">{c.evidence}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Issued keys" hint="plaintext is never retrievable" flush actions={<button onClick={() => void keys.refresh()}>Refresh</button>}>
        {list.length === 0 ? (
          <Empty>No keys issued. Use "Issue this epoch's keys" to mint a full set.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Fingerprint</th>
                <th className="num">Epoch</th>
                <th>Issued to</th>
                <th>Valid until</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 100).map((k) => {
                const expired = Date.parse(k.validTo) < Date.now();
                return (
                  <tr key={k.id} style={k.revokedAt || expired ? { opacity: 0.5 } : undefined}>
                    <td className="mono">{k.stage}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{k.fingerprint}</td>
                    <td className="num">{k.epoch}</td>
                    <td style={{ fontSize: 12 }}>{k.issuedToRole}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{formatTime(k.validTo)}</td>
                    <td>
                      {k.revokedAt ? (
                        <span className="badge critical" title={k.revokedReason ?? ""}>revoked</span>
                      ) : expired ? (
                        <span className="badge neutral">expired</span>
                      ) : (
                        <span className="badge ok">valid</span>
                      )}
                    </td>
                    <td>
                      {!k.revokedAt && !expired && (
                        <button
                          className="danger"
                          onClick={async () => {
                            const reason = prompt("Why is this key being revoked?");
                            if (!reason) return;
                            await api.revokeKey(k.id, reason);
                            await keys.refresh();
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
