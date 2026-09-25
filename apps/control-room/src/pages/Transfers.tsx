import { Fragment, useEffect, useState } from "react";
import { combineSeamShares, generateSeamLabel } from "@mohar/crypto-core";
import {
  api,
  type DemoJourney,
  type Leg,
  type TransferCheck,
  type TransferStep,
  type TransferStepResult,
} from "../lib/api";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";

/**
 * ── Hand-offs ────────────────────────────────────────────────────────────────
 *
 * Every planned leg of every packet's journey, where each one stands, and every
 * attempt the hand-off engine has ruled on.
 *
 * The console on the right stands in for the phones at either end of a leg. It
 * only drives legs this browser created, because only this browser holds their
 * label: a printed label is two QR codes, and the server keeps the commitment,
 * never the secret. What the console sends is whatever the operator chose — the
 * right label or a different one, the typed serial, who is holding the phone —
 * and what comes back is the engine's ruling, shown as it was recorded.
 *
 * The fingerprint is the one input with no hardware behind it here: the console
 * sends a slot and a score as the reader would, and the page says so.
 */

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

const JOURNEYS_KEY = "mohar.handoffJourneys";

function loadJourneys(): DemoJourney[] {
  try {
    const raw = localStorage.getItem(JOURNEYS_KEY);
    return raw ? (JSON.parse(raw) as DemoJourney[]) : [];
  } catch {
    return [];
  }
}

function saveJourneys(list: DemoJourney[]): void {
  try {
    localStorage.setItem(JOURNEYS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* the console just forgets these legs on reload */
  }
}

const role = (r: string) => r.replace(/_/g, " ");

function legStatus(l: Leg): { text: string; cls: string } {
  if (l.completed) return { text: "closed", cls: "ok" };
  if (l.key_issued_at) return { text: "key released · awaiting confirm", cls: "info" };
  if (l.dispatched) return { text: "dispatched · awaiting receiver", cls: "info" };
  return { text: "planned", cls: "neutral" };
}

function dueText(l: Leg): string {
  if (l.completed) return "—";
  const ms = Date.parse(l.expected_by) - Date.now();
  const abs = Math.abs(ms) / 1000;
  const fmt =
    abs < 60 ? `${Math.floor(abs)}s` :
    abs < 3600 ? `${Math.floor(abs / 60)}m ${Math.floor(abs % 60)}s` :
    `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
  return ms >= 0 ? `in ${fmt}` : `late by ${fmt}`;
}

function Checks({ checks }: { checks: TransferCheck[] }) {
  return (
    <div>
      {checks.map((c) => (
        <div
          key={c.check}
          className={`check ${c.passed === true ? "pass" : c.passed === false ? "fail" : "skip"}`}
        >
          <span className="check-name mono">{c.check}</span>
          <span className="check-evidence">{c.evidence}</span>
        </div>
      ))}
    </div>
  );
}

type LabelChoice = "this" | "other" | "none";
type FingerChoice = "match" | "weak" | "none";

export default function Transfers() {
  const legs = useAsync(() => api.legs(), [], { pollMs: 5_000 });
  const [journeys, setJourneys] = useState<DemoJourney[]>(loadJourneys);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [recorded, setRecorded] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const list = legs.data?.legs ?? [];
  const leg = list.find((l) => l.id === selected) ?? null;
  const journey = leg ? journeys.find((j) => j.packageId === leg.package_id) ?? null : null;

  async function newJourney() {
    setCreating(true);
    setErr(null);
    try {
      const j = await api.demoJourney();
      const next = [j, ...journeys];
      setJourneys(next);
      saveJourneys(next);
      await legs.refresh();
      setSelected(j.legIds[0] ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  if (legs.error) return <ErrorNote error={legs.error} />;

  const open = list.filter((l) => !l.completed).length;
  const late = list.filter((l) => l.overdue).length;

  return (
    <>
      <div className="note">
        Every leg is handed over the same way: the sender scans both codes on the label and gives a
        fingerprint, the receiver scans the label, types the serial printed on the packet and gives
        a fingerprint, and only then does the receiver's phone get a one-time key that closes the
        leg. <strong>The sender never sees that key.</strong> Every attempt is recorded before the
        answer comes back, refused ones included.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {list.length} legs · {open} open · {late} past expected-by
        </span>
        <div className="spacer" />
        <button onClick={() => void legs.refresh()}>Refresh</button>
        <button className="primary" disabled={creating} onClick={() => void newJourney()}>
          {creating ? "Sealing…" : "New packet to hand off"}
        </button>
      </div>

      <div className="grid main-side">
        <div style={{ display: "grid", gap: 14 }}>
          <Card title="Legs" hint="press → courier → strong room" flush>
            {list.length === 0 ? (
              <Empty>No legs planned yet. Press "New packet to hand off" to seal one.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Packet</th>
                    <th>Leg</th>
                    <th>Status</th>
                    <th>Expected by</th>
                    <th className="num">Refused</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((l) => {
                    const st = legStatus(l);
                    return (
                      <tr
                        key={l.id}
                        className="clickable"
                        onClick={() => setSelected(l.id)}
                        style={l.id === selected ? { background: "var(--surface-2)" } : undefined}
                      >
                        <td>
                          <div className="mono" style={{ fontSize: 12 }}>{l.seal_serial ?? "—"}</div>
                          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{l.centre_code}</div>
                        </td>
                        <td>
                          <div>
                            <span className="mono">{l.leg_no}</span> · {l.from_place} → {l.to_place}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                            {role(l.from_role)} → {role(l.to_role)}
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${st.cls}`}>{st.text}</span>
                          {l.overdue && (
                            <span className="badge high" style={{ marginLeft: 6 }}>
                              past expected-by
                            </span>
                          )}
                        </td>
                        <td className="mono" title={formatTime(l.expected_by)}>{dueText(l)}</td>
                        <td className="num mono">{l.refused_attempts}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          {leg && <AttemptHistory legId={leg.id} recorded={recorded} key={leg.id} />}
        </div>

        {leg ? (
          journey ? (
            <Console leg={leg} journey={journey} onDone={() => {
                void legs.refresh();
                setRecorded((n) => n + 1);
              }} key={leg.id} />
          ) : (
            <Card title="Hand-off console">
              <Empty>
                This packet's label was not printed from this browser, so there is nothing here to
                scan. Its legs and attempts can be followed on the left.
              </Empty>
            </Card>
          )
        ) : (
          <Card title="Hand-off console">
            <Empty>Select a leg to hand it over.</Empty>
          </Card>
        )}
      </div>
    </>
  );
}

function AttemptHistory({ legId, recorded }: { legId: string; recorded: number }) {
  // `recorded` changes whenever the console gets an answer, so the attempt it
  // just made shows up at once instead of on the next poll.
  const attempts = useAsync(() => api.legAttempts(legId), [legId, recorded], { pollMs: 5_000 });
  const [open, setOpen] = useState<string | null>(null);
  const list = attempts.data?.attempts ?? [];

  return (
    <Card title="Attempts on this leg" hint="as recorded, newest first" flush>
      {attempts.error ? (
        <ErrorNote error={attempts.error} />
      ) : list.length === 0 ? (
        <Empty>Nothing attempted on this leg yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Step</th>
              <th>Who</th>
              <th>Outcome</th>
              <th>Why</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => {
              const failed = a.checks.filter((c) => c.passed === false);
              return (
                <Fragment key={a.id}>
                  <tr className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    <td className="num mono">{a.attempt_no}</td>
                    <td className="mono">{a.step}</td>
                    <td>
                      {a.person_name ?? "—"}
                      {a.person_role && (
                        <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{role(a.person_role)}</div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${a.outcome === "granted" ? "ok" : "critical"}`}>{a.outcome}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {failed.map((c) => c.reason ?? c.check).join(", ") || "—"}
                    </td>
                    <td className="mono" title={formatTime(a.recorded_at)}>{relativeTime(a.recorded_at)}</td>
                  </tr>
                  {open === a.id && (
                    <tr>
                      <td colSpan={6} style={{ padding: "8px 12px" }}>
                        <Checks checks={a.checks} />
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
  );
}

function Console({ leg, journey, onDone }: { leg: Leg; journey: DemoJourney; onDone: () => void }) {
  const people = Object.values(journey.people);
  const nextStep: TransferStep = !leg.dispatched ? "dispatch" : !leg.key_issued_at ? "receive" : "confirm";
  const expectedRole = nextStep === "dispatch" ? leg.from_role : leg.to_role;

  const [personId, setPersonId] = useState(
    () => people.find((p) => p.role === expectedRole)?.id ?? people[0]?.id ?? "",
  );
  const [labelChoice, setLabelChoice] = useState<LabelChoice>("this");
  const [finger, setFinger] = useState<FingerChoice>("match");
  const [serial, setSerial] = useState(journey.serial);
  // The key lives only in this component, as it would only live on the
  // receiver's phone. A reload loses it, and the ledger will not issue it twice.
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [keyTyped, setKeyTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransferStepResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const p = people.find((x) => x.role === expectedRole);
    if (p) setPersonId(p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedRole]);

  async function run(step: TransferStep) {
    setBusy(true);
    setErr(null);
    try {
      let seam: { seamIdRead?: string; seamSecretHex?: string } = {};
      if (labelChoice === "this") {
        const secret = combineSeamShares(
          fromHex(journey.label.shareAHex),
          fromHex(journey.label.shareBHex),
        );
        seam = { seamIdRead: journey.label.seamId, seamSecretHex: toHex(secret) };
      } else if (labelChoice === "other") {
        // A genuine label from some other packet, peeled off and stuck on this one.
        const other = generateSeamLabel();
        seam = { seamIdRead: other.seamId, seamSecretHex: toHex(other.seamSecret) };
      }
      const r = await api.transferStep(leg.id, step, {
        deviceId: journey.deviceId,
        personId,
        ...seam,
        ...(finger === "none" ? {} : { biometricSlot: 3, biometricScore: finger === "match" ? 180 : 40 }),
        ...(step === "receive" ? { packetSerialTyped: serial } : {}),
        ...(step === "confirm" ? { transferKey: keyTyped } : {}),
        occurredAt: new Date().toISOString(),
      });
      setResult(r);
      if (r.transferKey) {
        setHeldKey(r.transferKey);
        setKeyTyped(r.transferKey);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const refusedChecks = result?.checks.filter((c) => c.passed === false) ?? [];

  return (
    <Card title="Hand-off console" hint={`leg ${leg.leg_no} · ${journey.serial}`}>
      <div className="note" style={{ marginBottom: 12 }}>
        Stands in for the phone at each end. <strong>Fingerprint input is simulated</strong> — no
        reader is attached to this console, so it sends a slot and score as the reader would.
        Everything else is ruled on by the real hand-off engine.
      </div>

      {leg.completed ? (
        <div className="verdict granted">LEG CLOSED</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            Next: <strong className="mono">{nextStep}</strong> by the {role(expectedRole)}
          </div>
          <div className="form">
            <label>Holding the phone</label>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({role(p.role)})
                </option>
              ))}
            </select>

            <label>Label scanned</label>
            <select value={labelChoice} onChange={(e) => setLabelChoice(e.target.value as LabelChoice)}>
              <option value="this">this packet's label, both codes</option>
              <option value="other">a label from another packet</option>
              <option value="none">not scanned</option>
            </select>

            <label>Fingerprint</label>
            <select value={finger} onChange={(e) => setFinger(e.target.value as FingerChoice)}>
              <option value="match">matched, score 180</option>
              <option value="weak">weak match, score 40</option>
              <option value="none">not presented</option>
            </select>

            {nextStep === "receive" && (
              <>
                <label>Serial typed</label>
                <input type="text" value={serial} onChange={(e) => setSerial(e.target.value)} />
              </>
            )}

            {nextStep === "confirm" && (
              <>
                <label>Key entered</label>
                <input
                  type="text"
                  className="mono"
                  value={keyTyped}
                  placeholder="8 characters"
                  onChange={(e) => setKeyTyped(e.target.value.toUpperCase())}
                />
              </>
            )}
          </div>

          {nextStep === "confirm" && (
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
              {heldKey
                ? `The receiver's phone holds ${heldKey}. Change it to try a wrong key; the third wrong key raises an alert.`
                : "This page did not receive the key (it was released before a reload). Only the receiving phone ever had it."}
            </div>
          )}

          <button
            className="primary"
            style={{ marginTop: 12 }}
            disabled={busy || !personId}
            onClick={() => void run(nextStep)}
          >
            {busy ? "…" : nextStep === "dispatch" ? "Dispatch" : nextStep === "receive" ? "Receive" : "Confirm with key"}
          </button>
        </>
      )}

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <div className={result.outcome === "granted" ? "verdict granted" : "verdict denied"}>
            {result.step.toUpperCase()} {result.outcome === "granted" ? "GRANTED" : "REFUSED"}
            <span style={{ opacity: 0.75, fontWeight: 400, marginLeft: 8 }}>attempt {result.attemptNo}</span>
          </div>
          {result.transferKey && (
            <div className="note" style={{ marginTop: 8 }}>
              Key released to the receiver's phone only: <strong className="mono">{result.transferKey}</strong>{" "}
              (fingerprint <span className="mono">{result.keyFingerprint}</span>). The server keeps its hash.
            </div>
          )}
          {result.alertRaised && (
            <div className="banner" style={{ marginTop: 8 }}>
              Alert raised: this leg has refused its limit of attempts. Further attempts are refused
              until the control room decides how the hand-off proceeds.
            </div>
          )}
          {refusedChecks.length > 0 && (
            <div style={{ fontSize: 12, margin: "10px 0 6px", color: "var(--text-dim)" }}>
              Refused for: <span className="mono">{result.denyReasons.join(", ")}</span>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <Checks checks={result.checks} />
          </div>
        </div>
      )}
    </Card>
  );
}
