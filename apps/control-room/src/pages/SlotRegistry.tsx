import { useMemo, useState } from "react";
import { api, type FingerprintEnrolment } from "../lib/api";
import { useAsync, formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import StationPanel from "../components/StationPanel";

/**
 * ── Who template slot 3 actually is ──────────────────────────────────────────
 *
 * The reader gives up a slot number and a score, and that is all the chain ever
 * records. It is what makes a breach of this database unable to leak a
 * biometric: there is no biometric in it.
 *
 * But "slot 3 matched" is not an answer to "who opened the package". This panel
 * is the missing half — a register mapping (station, slot) to a person on the
 * roster. It is deliberately reference data and deliberately not in the ledger:
 * the chain holds signed facts, and a mapping recorded against the wrong person
 * has to be correctable. Correcting a signed fact is the one thing the chain
 * must never allow.
 *
 * Nothing here is a biometric. No image, no template, no minutiae — only that a
 * named person's finger was enrolled into a numbered slot on a named device.
 */
export default function SlotRegistry() {
  const { data, error, refresh } = useAsync(() => api.fingerprints(), [], {
    pollMs: 15_000,
  });
  const { data: devices } = useAsync(() => api.devices(), []);
  const { data: persons } = useAsync(() => api.persons(), []);

  const [deviceId, setDeviceId] = useState("");
  const [slot, setSlot] = useState("");
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<"superintendent" | "observer">("superintendent");
  const [fingerLabel, setFingerLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Only devices that could plausibly hold templates. A slot on a service
  // identity or a phone is meaningless, and offering them invites a mapping
  // nobody can ever match against.
  const stations = useMemo(
    () => (devices?.devices ?? []).filter((d) => d.kind === "monitor" && !d.revokedAt),
    [devices],
  );

  const live = (data?.enrolments ?? []).filter((e) => !e.revokedAt);
  const retired = (data?.enrolments ?? []).filter((e) => e.revokedAt);

  const submit = async () => {
    setFormError(null);
    const n = Number(slot);
    if (!deviceId) return setFormError("Choose the station whose reader holds the template.");
    if (!Number.isInteger(n) || n < 1 || n > 127)
      return setFormError("Slot must be a whole number between 1 and 127.");
    if (!personId) return setFormError("Choose who this slot belongs to.");

    setBusy(true);
    try {
      await api.enrolFingerprint({
        deviceId,
        templateSlot: n,
        personId,
        role,
        ...(fingerLabel.trim() ? { fingerLabel: fingerLabel.trim() } : {}),
      });
      setSlot("");
      setFingerLabel("");
      await refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (e: FingerprintEnrolment) => {
    const reason = window.prompt(
      `Retire slot ${e.templateSlot} (${e.personName})?\n\nWhy? This is kept on the record.`,
    );
    if (!reason?.trim()) return;
    try {
      await api.revokeEnrolment(e.id, reason.trim());
      await refresh();
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  return (
    <div className="witness">
      {error && <ErrorNote error={error} />}

      <StationPanel onEnrolled={() => void refresh()} />

      <Card
        title="Register a template slot"
        hint="Enrol the finger on the station first, then say here whose it is"
      >
        <div className="slot-form">
          <label>
            <span>Station</span>
            <select
              className="wit-select"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">— choose —</option>
              {stations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id.slice(0, 8)}… {d.centreId ? "· bound to a centre" : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Slot</span>
            <input
              className="wit-select"
              inputMode="numeric"
              placeholder="1–127"
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
            />
          </label>

          <label>
            <span>Person</span>
            <select
              className="wit-select"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              <option value="">— choose —</option>
              {(persons?.persons ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} · {p.role}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Capacity</span>
            <select
              className="wit-select"
              value={role}
              onChange={(e) => setRole(e.target.value as "superintendent" | "observer")}
            >
              <option value="superintendent">superintendent</option>
              <option value="observer">observer</option>
            </select>
          </label>

          <label>
            <span>Which finger</span>
            <input
              className="wit-select"
              placeholder="right index"
              value={fingerLabel}
              onChange={(e) => setFingerLabel(e.target.value)}
            />
          </label>

          <button className="wit-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? "Registering…" : "Register slot"}
          </button>
        </div>

        {formError && <div className="wit-error">{formError}</div>}

        <div className="wit-note">
          Enrol three fingers per person. Optical readers fail on dry, worn and
          work-hardened hands, which is exactly this workforce — and the station's serial
          console takes <code>e</code> to enrol without swapping firmware. A slot that
          matches but is not registered here is reported by the access engine as
          "not mapped to anyone on the roster", which is a finding rather than a fault:
          it means a finger was enrolled outside the process.
        </div>
      </Card>

      <Card title="Live slots" hint="One mapping per slot per station">
        {live.length === 0 ? (
          <Empty>No template slots are registered yet.</Empty>
        ) : (
          <table className="slot-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Person</th>
                <th>Capacity</th>
                <th>Finger</th>
                <th>Station</th>
                <th>Registered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.templateSlot}</td>
                  <td>{e.personName}</td>
                  <td>{e.role}</td>
                  <td>{e.fingerLabel ?? "—"}</td>
                  <td className="mono">{e.deviceId.slice(0, 8)}…</td>
                  <td>{formatTime(e.enrolledAt)}</td>
                  <td>
                    <button className="wit-btn ghost" onClick={() => void retire(e)}>
                      Retire
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {retired.length > 0 && (
        <Card
          title="Retired slots"
          hint="Kept because an assertion signed last month refers to whoever held the slot then"
        >
          <table className="slot-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Person</th>
                <th>Retired</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {retired.map((e) => (
                <tr key={e.id} className="dim">
                  <td className="mono">{e.templateSlot}</td>
                  <td>{e.personName}</td>
                  <td>{e.revokedAt ? formatTime(e.revokedAt) : "—"}</td>
                  <td>{e.revokedReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
