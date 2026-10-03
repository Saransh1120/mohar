import { Fragment, useState } from "react";
import { api } from "../lib/api";
import { useAsync, formatTime, relativeTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import { CheckList } from "../components/CheckList";

const KIND_NOTE: Record<string, string> = {
  field: "A courier's or officer's phone",
  centre_pc: "The centre's own PC or station",
  monitor: "ESP32 room monitor",
  service: "A backend service signing its own derived events",
};

export default function Devices() {
  const devices = useAsync(() => api.devices(), [], { pollMs: 20_000 });
  // Read separately so that a database without the attestation table still
  // lists its devices; the column then says the ruling could not be read.
  const rulings = useAsync(() => api.deviceAttestations(), [], { pollMs: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
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
  const rulingFor = new Map((rulings.data?.attestations ?? []).map((a) => [a.deviceId, a]));

  return (
    <>
      <div className="note">
        <strong>An attestation is checked when one is presented; so far none has been.</strong>{" "}
        A phone can present an Android Keystore certificate chain at enrolment, and the ledger
        checks it against its configured roots: that the key is held in secure hardware, that it
        answers a challenge issued for it, and that the phone booted a locked, verified system. A
        chain that fails enrols nothing. But the field app is a web page and cannot ask a Keystore
        for one, so every device below that says "none presented" still rests on the operator who
        enrolled it. A centre PC can present a TPM quote instead. A TPM does not hold this kind
        of key, so a quote that passes shows only that a real TPM was at the enrolment and signed
        for the key; the key itself stays in software and can be copied. No client produces a
        quote yet either. See{" "}
        <span className="mono">adr/0003</span>.
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
                <th>Where the key is held</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => {
                const ruling = rulingFor.get(d.id);
                return (
                <Fragment key={d.id}>
                <tr style={d.revokedAt ? { opacity: 0.5 } : undefined}>
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
                  <td style={{ fontSize: 12 }}>
                    {rulings.error ? (
                      <span style={{ color: "var(--text-faint)" }}>ruling could not be read</span>
                    ) : !ruling ? (
                      <span style={{ color: "var(--text-faint)" }}>
                        no ruling on record (enrolled before rulings were kept)
                      </span>
                    ) : ruling.outcome === "verified" ? (
                      <button onClick={() => setOpen(open === d.id ? null : d.id)}>
                        {ruling.facts.kind === "tpm-quote"
                          ? `a TPM vouched for it: ${ruling.facts.keyHeldIn ?? "the key is held in software"}`
                          : `attested: ${ruling.facts.keyMintSecurityLevel ?? "secure hardware"}, boot ${
                              ruling.facts.verifiedBootState ?? "unknown"
                            }`}
                      </button>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>
                        none presented; taken on the enrolling operator's word
                      </span>
                    )}
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
                {open === d.id && ruling && (
                  <tr>
                    <td colSpan={7} style={{ background: "var(--bg-sunken, transparent)" }}>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                        Ruled {formatTime(ruling.recordedAt)}
                        {ruling.facts.rootSubject ? `; chain ends at ${ruling.facts.rootSubject}` : ""}
                      </div>
                      <CheckList checks={ruling.checks} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
