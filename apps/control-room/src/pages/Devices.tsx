import { useState } from "react";
import { api } from "../lib/api";
import { useAsync, formatTime, relativeTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";

const KIND_NOTE: Record<string, string> = {
  field: "Android phone, Keystore-attested",
  centre_pc: "The centre's own Windows PC, TPM-bound",
  monitor: "ESP32 room monitor",
  service: "A backend service signing its own derived events",
};

export default function Devices() {
  const devices = useAsync(() => api.devices(), [], { pollMs: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function revoke(id: string) {
    if (!confirm(
      "Revoke this device?\n\n" +
      "Events it has already signed stay valid and stay in the chain. " +
      "Revocation only means: trust nothing signed by this key from now on.",
    )) return;
    setBusy(id);
    setErr(null);
    try {
      await api.revokeDevice(id);
      await devices.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (devices.error) return <ErrorNote error={devices.error} />;
  const list = devices.data?.devices ?? [];

  return (
    <>
      <div className="note">
        <strong>Attestation is accepted but not yet verified.</strong> There is no Android Keystore
        root-of-trust check in this build, so enrolment currently trusts whoever can reach the
        endpoint. That is a real gap, not a simplification — see{" "}
        <span className="mono">adr/0003</span>. Enrolment must stay behind the gateway until it is
        closed.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {list.filter((d) => !d.revokedAt).length} active · {list.filter((d) => d.revokedAt).length} revoked
        </span>
        <div className="spacer" />
        <button onClick={() => void devices.refresh()}>Refresh</button>
      </div>

      <Card flush>
        {list.length === 0 ? (
          <Empty>No devices enrolled. Run the seed tool to enrol a set.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Device ID</th>
                <th>Public key</th>
                <th>Enrolled</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} style={d.revokedAt ? { opacity: 0.5 } : undefined}>
                  <td>
                    <span className="badge neutral">{d.kind}</span>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                      {KIND_NOTE[d.kind] ?? ""}
                    </div>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.id}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {d.pubkey.slice(0, 24)}…
                  </td>
                  <td className="mono" title={formatTime(d.enrolledAt)}>
                    {relativeTime(d.enrolledAt)}
                  </td>
                  <td>
                    {d.revokedAt ? (
                      <span className="badge critical" title={formatTime(d.revokedAt)}>
                        revoked
                      </span>
                    ) : (
                      <span className="badge ok">active</span>
                    )}
                  </td>
                  <td>
                    {!d.revokedAt && (
                      <button
                        className="danger"
                        disabled={busy === d.id}
                        onClick={() => void revoke(d.id)}
                      >
                        {busy === d.id ? "…" : "Revoke"}
                      </button>
                    )}
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
