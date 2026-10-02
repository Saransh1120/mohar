import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type DutyRole,
  type DutyRoster,
  type LockResult,
  type Person,
  type ReissueResult,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import { becomeStation, currentStation, type Station } from "../lib/openingStation";
import { Card, Empty, ErrorNote } from "../components/ui";
import { CheckList, durationText, roleText } from "../components/CheckList";

/**
 * ── Duty rosters ─────────────────────────────────────────────────────────────
 *
 * Who the three officials are at each centre, and the moment that list is
 * locked. Locking is not a formality. It is when each packet's opening key is
 * made and taken apart: the control room's part is time-locked to the public
 * beacon round fifteen minutes before the exam, each official's share is
 * wrapped to the station that will run the opening, and the key itself is
 * dropped. After that this server holds ciphertext it cannot read.
 *
 * So the page shows two different things for a roster. Before locking, names
 * that can still be changed. After, what was issued: the round each packet's
 * control part opens at, and the commitment its key will be checked against.
 *
 * A roster is locked a day ahead. Inside the last day the engine still locks
 * it, but only with a stated reason, and the lock is recorded as late. After
 * the lock a name can only change by a re-issue: every unopened packet gets a
 * new key, because the share wrapped for the person who is no longer coming
 * cannot be handed to anyone else. Both are listed under the roster as they
 * were recorded.
 */

const DAY_MS = 24 * 3600_000;

const ROLES: DutyRole[] = ["superintendent", "observer", "police_escort"];

export default function Rosters() {
  const rosters = useAsync(() => api.rosters(), [], { pollMs: 8_000 });
  const persons = useAsync(() => api.persons(), []);
  const [station, setStation] = useState<Station | null>(null);
  const [pairing, setPairing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    void currentStation().then(setStation);
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function pair() {
    setPairing(true);
    setErr(null);
    try {
      setStation(await becomeStation());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPairing(false);
    }
  }

  if (rosters.error) return <ErrorNote error={rosters.error} />;
  const list = rosters.data?.rosters ?? [];

  return (
    <>
      <div className="note">
        A roster is locked a day before the exam. Locking makes each packet's opening key and
        immediately takes it apart: <strong>the control room's part is time-locked</strong> to the
        public beacon round fifteen minutes before the exam, and each official's share is{" "}
        <strong>wrapped to the opening station</strong>. Nothing readable is kept. From then on
        nobody can open the packet early, including whoever runs this server. A roster and a packet
        to open are made from the <Link to="/ceremonies">Ceremonies</Link> page.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {station ? (
            <>
              This browser is station <span className="mono">{station.deviceId.slice(0, 8)}…</span>, with
              an unwrap key the browser holds and this page cannot read
            </>
          ) : (
            "This browser is not a station yet"
          )}
        </span>
        <div className="spacer" />
        <button onClick={() => void rosters.refresh()}>Refresh</button>
        {!station && (
          <button className="primary" disabled={pairing} onClick={() => void pair()}>
            {pairing ? "Pairing…" : "Make this browser the station"}
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <Empty>
            No duty roster exists yet. On the Ceremonies page, "New packet due to open" makes a packet,
            its three officials and an unlocked roster for them.
          </Empty>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {list.map((r) => (
            <RosterCard
              key={`${r.centre_id}-${r.exam_session}`}
              roster={r}
              persons={persons.data?.persons ?? []}
              station={station}
              onChanged={() => void rosters.refresh()}
            />
          ))}
        </div>
      )}
    </>
  );
}

function RosterCard({
  roster: r,
  persons,
  station,
  onChanged,
}: {
  roster: DutyRoster;
  persons: Person[];
  station: Station | null;
  onChanged: () => void;
}) {
  const { account } = useAuth();
  const lockedAt = r.duty.find((d) => d.lockedAt)?.lockedAt ?? null;
  const [stationId, setStationId] = useState(station?.deviceId ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LockResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lateReason, setLateReason] = useState("");
  const [swapRole, setSwapRole] = useState<DutyRole>("police_escort");
  const [swapPerson, setSwapPerson] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const [reissued, setReissued] = useState<ReissueResult | null>(null);

  useEffect(() => {
    if (station && !stationId) setStationId(station.deviceId);
  }, [station, stationId]);

  const opensIn = Date.parse(r.starts_at) - 15 * 60_000 - Date.now();
  const insideLastDay = Date.parse(r.starts_at) - Date.now() < DAY_MS;
  const nameOf = (personId: string) =>
    persons.find((p) => p.id === personId)?.displayName ??
    r.duty.find((d) => d.personId === personId)?.personName ??
    `${personId.slice(0, 8)}…`;
  const replacements = persons.filter(
    (p) => p.role === swapRole && p.id !== r.duty.find((d) => d.role === swapRole)?.personId,
  );

  async function assign(role: DutyRole, personId: string) {
    setErr(null);
    try {
      await api.assignRoster(r.centre_id, r.exam_session, [{ role, personId }]);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function lock() {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.lockRoster(r.centre_id, r.exam_session, stationId.trim(), lateReason));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reissue() {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.reissueRoster(
        r.centre_id,
        r.exam_session,
        [{ role: swapRole, personId: swapPerson }],
        swapReason,
      );
      setReissued(out);
      if (out.outcome === "reissued") {
        setSwapPerson("");
        setSwapReason("");
      }
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`${r.centre_code} · ${r.exam_name}`}
      hint={`exam starts ${formatTime(r.starts_at)} · ${r.packets} packet${r.packets === 1 ? "" : "s"}`}
      actions={
        <span className={`badge ${lockedAt ? "ok" : "info"}`}>
          {lockedAt ? `locked ${relativeTime(lockedAt)}` : "not locked"}
        </span>
      }
    >
      <table>
        <thead>
          <tr>
            <th>Holds the share of</th>
            <th>Official</th>
            <th>Answers to</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => {
            const d = r.duty.find((x) => x.role === role);
            const eligible = persons.filter((p) => p.role === role);
            return (
              <tr key={role}>
                <td>{roleText(role)}</td>
                <td>
                  {lockedAt || eligible.length === 0 ? (
                    d ? d.personName : <span style={{ color: "var(--text-faint)" }}>nobody assigned</span>
                  ) : (
                    <select value={d?.personId ?? ""} onChange={(e) => void assign(role, e.target.value)}>
                      {!d && <option value="">nobody assigned</option>}
                      {/* The person already assigned may not be in the first page of persons. */}
                      {d && !eligible.some((p) => p.id === d.personId) && (
                        <option value={d.personId}>{d.personName}</option>
                      )}
                      {eligible.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {role === "superintendent"
                    ? `Examination centre ${r.centre_code}`
                    : role === "observer"
                      ? "Board of examinations"
                      : "State police"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {r.issued.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Keys in force
            {(r.issued[0]?.issueNo ?? 1) > 1 && ` · issue ${r.issued[0]?.issueNo}`}
          </div>
          <table>
            <thead>
              <tr>
                <th>Packet</th>
                <th>Control part opens</th>
                <th>drand round</th>
                <th>Shares wrapped to</th>
                <th>Key commitment</th>
              </tr>
            </thead>
            <tbody>
              {r.issued.map((k) => {
                const ms = Date.parse(k.scheduledOpenAt) - Date.now();
                return (
                  <tr key={k.packageId}>
                    <td className="mono">{k.packetSerial ?? k.packageId.slice(0, 8)}</td>
                    <td title={formatTime(k.scheduledOpenAt)}>
                      {ms > 0 ? `in ${durationText(ms / 1000)}` : `${durationText(ms / 1000)} ago`}
                    </td>
                    <td className="mono">{k.drandRound}</td>
                    <td className="mono">{k.stationDeviceId.slice(0, 8)}…</td>
                    <td className="mono">{k.keyCommitment.slice(0, 16)}…</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!lockedAt && (
        <div style={{ marginTop: 14 }}>
          <div className="form">
            <label>Station</label>
            <input
              type="text"
              className="mono"
              value={stationId}
              placeholder="device id of the opening station"
              onChange={(e) => setStationId(e.target.value)}
            />
          </div>
          {insideLastDay && opensIn > 0 && (
            <div className="form" style={{ marginTop: 9 }}>
              <label>Why late</label>
              <input
                type="text"
                value={lateReason}
                placeholder="a roster is locked a day ahead; say why this one is not"
                onChange={(e) => setLateReason(e.target.value)}
              />
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
            {opensIn <= 0
              ? "The opening time for this exam has passed, so there is no future round to lock a key to."
              : insideLastDay
                ? `These packets open in ${durationText(opensIn / 1000)}, inside the last day. The engine locks ` +
                  "it only with a reason, and records the lock as late with that reason."
                : `These packets open in ${durationText(opensIn / 1000)}. That is more than a day ahead, as the procedure asks.`}
            {!account && " Sign in to lock a roster."}
          </div>
          <button
            className="primary"
            style={{ marginTop: 10 }}
            disabled={busy || !stationId.trim() || !account}
            onClick={() => void lock()}
          >
            {busy ? "Locking…" : "Lock the roster and issue the keys"}
          </button>
        </div>
      )}

      {r.issues.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Locks and re-issues, as recorded
          </div>
          <table>
            <thead>
              <tr>
                <th className="num">Issue</th>
                <th>What</th>
                <th>Before the exam</th>
                <th>By</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {r.issues.map((i) => (
                <tr key={i.issueNo}>
                  <td className="num mono">{i.issueNo}</td>
                  <td>
                    {i.kind === "lock" ? "locked" : "re-issued"}
                    {i.late && i.kind === "lock" && (
                      <span className="badge high" style={{ marginLeft: 6 }}>
                        inside the last day
                      </span>
                    )}
                    {i.changes.map((ch) => (
                      <div key={ch.role} style={{ fontSize: 11, color: "var(--text-faint)" }}>
                        {roleText(ch.role)}: {nameOf(ch.fromPersonId)} → {nameOf(ch.toPersonId)}
                      </div>
                    ))}
                  </td>
                  <td className="mono">{durationText(i.leadSeconds)}</td>
                  <td>{i.by ?? "—"}</td>
                  <td style={{ fontSize: 12 }}>{i.reason ?? "—"}</td>
                  <td className="mono" title={formatTime(i.issuedAt)}>{relativeTime(i.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lockedAt && opensIn > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Replace an official
          </div>
          <div className="form" style={{ marginTop: 8 }}>
            <label>Role</label>
            <select
              value={swapRole}
              onChange={(e) => {
                setSwapRole(e.target.value as DutyRole);
                setSwapPerson("");
              }}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleText(role)}: {r.duty.find((d) => d.role === role)?.personName ?? "nobody"}
                </option>
              ))}
            </select>
            <label>Replaced by</label>
            <select value={swapPerson} onChange={(e) => setSwapPerson(e.target.value)}>
              <option value="">
                {replacements.length === 0 ? `nobody else is on record as ${roleText(swapRole)}` : "choose"}
              </option>
              {replacements.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <label>Reason</label>
            <input
              type="text"
              value={swapReason}
              placeholder="why the official on the locked roster is being replaced"
              onChange={(e) => setSwapReason(e.target.value)}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
            Every packet at this centre that has not been opened gets a new key, new shares for all
            three officials and a new time-locked envelope. The earlier issue stays on record and
            stops being the one that opens the packet. A ceremony already begun has to start again.
          </div>
          <button
            style={{ marginTop: 10 }}
            disabled={busy || !swapPerson || swapReason.trim().length < 10 || !account}
            onClick={() => void reissue()}
          >
            {busy ? "Re-issuing…" : "Re-issue the roster"}
          </button>
        </div>
      )}

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}

      {reissued && (
        <div style={{ marginTop: 14 }}>
          <div className={reissued.outcome === "reissued" ? "verdict granted" : "verdict denied"}>
            {reissued.outcome === "reissued"
              ? `RE-ISSUED · ISSUE ${reissued.issueNo} · ${reissued.packets.length} NEW KEY${reissued.packets.length === 1 ? "" : "S"}`
              : "NOT RE-ISSUED"}
          </div>
          {reissued.denyReasons.length > 0 && (
            <div style={{ fontSize: 12, margin: "10px 0 6px", color: "var(--text-dim)" }}>
              Refused for: <span className="mono">{reissued.denyReasons.join(", ")}</span>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <CheckList checks={reissued.checks} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 14 }}>
          <div className={result.outcome === "locked" ? "verdict granted" : "verdict denied"}>
            {result.outcome === "locked"
              ? `LOCKED${result.late ? " LATE" : ""} · ${result.packets.length} KEY${result.packets.length === 1 ? "" : "S"} ISSUED`
              : "NOT LOCKED"}
          </div>
          {result.denyReasons.length > 0 && (
            <div style={{ fontSize: 12, margin: "10px 0 6px", color: "var(--text-dim)" }}>
              Refused for: <span className="mono">{result.denyReasons.join(", ")}</span>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <CheckList checks={result.checks} />
          </div>
        </div>
      )}
    </Card>
  );
}
