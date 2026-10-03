import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type DemoStrongRoom,
  type DoorEntrant,
  type DoorResult,
  type RoomVisit,
  type StrongRoom,
} from "../lib/api";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import { CheckList, durationText, roleText } from "../components/CheckList";

/**
 * ── Strong rooms ─────────────────────────────────────────────────────────────
 *
 * Every room, who is inside it now, every visit with how long it lasted against
 * how long it was expected to, and every attempt at the door including the
 * refused ones.
 *
 * The console on the right stands in for the device at the door. It can only
 * drive rooms this browser created, because the door device and the people
 * registered on its reader were made with the room. What it sends is whatever
 * the operator chooses - one person or two, whose finger, how far apart - and
 * what comes back is the door engine's ruling.
 *
 * The fingerprint and the face are the inputs with no hardware behind them
 * here: the console sends a slot, a score and a face result as the door device
 * would, and the page says so.
 */

const ROOMS_KEY = "mohar.demoStrongRooms";

function loadDemoRooms(): DemoStrongRoom[] {
  try {
    const raw = localStorage.getItem(ROOMS_KEY);
    return raw ? (JSON.parse(raw) as DemoStrongRoom[]) : [];
  } catch {
    return [];
  }
}

function saveDemoRooms(list: DemoStrongRoom[]): void {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* the console just forgets these rooms on reload */
  }
}

function heard(at: string | null, hasMonitor: boolean): string {
  if (!hasMonitor) return "no monitor";
  return at ? relativeTime(at) : "never";
}

export default function StrongRooms() {
  const rooms = useAsync(() => api.rooms(), [], { pollMs: 5_000 });
  const [demo, setDemo] = useState<DemoStrongRoom[]>(loadDemoRooms);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const list = rooms.data?.rooms ?? [];
  const room = list.find((r) => r.id === selected) ?? null;
  const demoRoom = room ? demo.find((d) => d.roomId === room.id) ?? null : null;

  async function newRoom() {
    setCreating(true);
    setErr(null);
    try {
      const d = await api.demoStrongRoom();
      const next = [d, ...demo];
      setDemo(next);
      saveDemoRooms(next);
      await rooms.refresh();
      setSelected(d.roomId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  if (rooms.error) return <ErrorNote error={rooms.error} />;

  const inside = list.reduce((n, r) => n + r.inside.length, 0);

  return (
    <>
      <div className="note">
        The door is gated, not only the packet. It opens to <strong>two people</strong>, each
        verified by fingerprint within 120 seconds of the other, and every entry and exit is
        recorded <strong>whether or not a packet is touched</strong>. A refused attempt is recorded
        too. A stay far longer than the task was expected to take is raised on the{" "}
        <Link to="/alerts">Alerts</Link> page for review, and so is a door monitor that counted more
        people going in than the door admitted.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {list.length} room{list.length === 1 ? "" : "s"} · {inside} visit{inside === 1 ? "" : "s"}{" "}
          with no exit on record
        </span>
        <div className="spacer" />
        <button onClick={() => void rooms.refresh()}>Refresh</button>
        <button className="primary" disabled={creating} onClick={() => void newRoom()}>
          {creating ? "Registering…" : "New strong room to try"}
        </button>
      </div>

      <div className="grid main-side">
        <div style={{ display: "grid", gap: 14 }}>
          <Card title="Rooms" flush>
            {list.length === 0 ? (
              <Empty>No strong room is registered. Press "New strong room to try" to make one.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Inside now</th>
                    <th>Monitor heard</th>
                    <th className="num">Visits</th>
                    <th className="num">Refused</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <RoomRow key={r.id} room={r} active={r.id === selected} onSelect={() => setSelected(r.id)} />
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {room && <RoomHistory roomId={room.id} recorded={recorded} demo={demoRoom} key={room.id} />}
        </div>

        {room ? (
          demoRoom ? (
            <DoorConsole
              room={room}
              demo={demoRoom}
              onDone={() => {
                void rooms.refresh();
                setRecorded((n) => n + 1);
              }}
              key={room.id}
            />
          ) : (
            <Card title="Door console">
              <Empty>
                This room's door device was not made from this browser, so there is nothing here to
                present a finger on. Its visits and attempts can be followed on the left.
              </Empty>
            </Card>
          )
        ) : (
          <Card title="Door console">
            <Empty>Select a room to try its door.</Empty>
          </Card>
        )}
      </div>
    </>
  );
}

function RoomRow({ room: r, active, onSelect }: { room: StrongRoom; active: boolean; onSelect: () => void }) {
  return (
    <tr className="clickable" onClick={onSelect} style={active ? { background: "var(--surface-2)" } : undefined}>
      <td>
        <div>{r.name}</div>
        <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
          {r.place}
          {r.centre_code && ` · ${r.centre_code}`}
        </div>
      </td>
      <td>
        {r.inside.length === 0 ? (
          <span className="badge neutral">empty</span>
        ) : (
          r.inside.map((v) => (
            <span key={v.visitId} className="badge info" title={formatTime(v.enteredAt)}>
              {v.persons.length} in for {durationText((Date.now() - Date.parse(v.enteredAt)) / 1000)}
            </span>
          ))
        )}
      </td>
      <td className="mono" title={r.monitor_last_heard ? formatTime(r.monitor_last_heard) : undefined}>
        {heard(r.monitor_last_heard, r.monitor_device_id !== null)}
      </td>
      <td className="num mono">{r.visits}</td>
      <td className="num mono">{r.refused_attempts}</td>
    </tr>
  );
}

function who(persons: DoorEntrant[], demo: DemoStrongRoom | null): string {
  if (persons.length === 0) return "nobody named";
  return persons
    .map((p) => demo?.people.find((d) => d.id === p.personId)?.name ?? `${p.personId.slice(0, 8)}…`)
    .join(", ");
}

function visitState(v: RoomVisit): { text: string; cls: string } {
  if (v.exited_at === null) {
    const over = (v.inside_seconds ?? 0) > v.limit_seconds;
    return over ? { text: "inside, past the limit", cls: "high" } : { text: "inside", cls: "info" };
  }
  return (v.dwell_seconds ?? 0) > v.limit_seconds
    ? { text: "left, stayed past the limit", cls: "high" }
    : { text: "left", cls: "ok" };
}

function RoomHistory({
  roomId,
  recorded,
  demo,
}: {
  roomId: string;
  recorded: number;
  demo: DemoStrongRoom | null;
}) {
  const history = useAsync(() => api.roomVisits(roomId), [roomId, recorded], { pollMs: 5_000 });
  const [open, setOpen] = useState<string | null>(null);
  const visits = history.data?.visits ?? [];
  const attempts = history.data?.attempts ?? [];

  if (history.error) return <ErrorNote error={history.error} />;

  return (
    <>
      <Card title="Visits" hint="newest first" flush>
        {visits.length === 0 ? (
          <Empty>Nobody has been let into this room yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>For</th>
                <th>State</th>
                <th>Inside for</th>
                <th>Footfall</th>
                <th>Entered</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => {
                const st = visitState(v);
                const seconds = v.dwell_seconds ?? v.inside_seconds ?? 0;
                return (
                  <tr key={v.id}>
                    <td>{who(v.persons, demo)}</td>
                    <td>
                      {v.task ?? "—"}
                      {v.packages_touched !== null && (
                        <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                          {v.packages_touched} packet{v.packages_touched === 1 ? "" : "s"} touched
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${st.cls}`}>{st.text}</span>
                    </td>
                    <td className="mono">
                      {durationText(seconds)}
                      <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                        expected {v.expected_minutes}m · limit {durationText(v.limit_seconds)}
                      </div>
                    </td>
                    <td style={{ fontSize: 11 }}>
                      {v.footfall_out
                        ? v.footfall_out.evaluated
                          ? v.footfall_out.detail
                          : "not evaluated"
                        : "—"}
                    </td>
                    <td className="mono" title={formatTime(v.entered_at)}>
                      {relativeTime(v.entered_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Attempts at the door" hint="as recorded, refused ones included" flush>
        {attempts.length === 0 ? (
          <Empty>Nothing attempted at this door yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Who</th>
                <th>Outcome</th>
                <th>Why</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => {
                const failed = a.checks.filter((c) => c.passed === false);
                return (
                  <Fragment key={a.id}>
                    <tr className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)}>
                      <td className="mono">{a.kind}</td>
                      <td>{who(a.persons, demo)}</td>
                      <td>
                        <span className={`badge ${a.outcome === "granted" ? "ok" : "critical"}`}>
                          {a.outcome}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {failed.map((c) => c.reason ?? c.check).join(", ") || "—"}
                      </td>
                      <td className="mono" title={formatTime(a.recorded_at)}>
                        {relativeTime(a.recorded_at)}
                      </td>
                    </tr>
                    {open === a.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: "8px 12px" }}>
                          <CheckList checks={a.checks} />
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

type FingerChoice = "own" | "weak" | "other" | "none";
type FaceChoice = "unread" | "matched" | "failed";

function DoorConsole({ room, demo, onDone }: { room: StrongRoom; demo: DemoStrongRoom; onDone: () => void }) {
  const [first, setFirst] = useState(demo.people[0]?.id ?? "");
  const [second, setSecond] = useState(demo.people[1]?.id ?? "");
  const [finger, setFinger] = useState<FingerChoice>("own");
  const [face, setFace] = useState<FaceChoice>("unread");
  const [apart, setApart] = useState(20);
  const [task, setTask] = useState("collect one packet");
  const [expected, setExpected] = useState(4);
  const [touched, setTouched] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(DoorResult & { kind: "entry" | "exit" }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const open = room.inside[0] ?? null;

  function entrant(personId: string, isSecond: boolean): DoorEntrant | null {
    const person = demo.people.find((p) => p.id === personId);
    if (!person) return null;
    const at = new Date(Date.now() - (isSecond ? 0 : apart * 1000)).toISOString();
    const e: DoorEntrant = { personId, assertedAt: at };
    if (finger !== "none") {
      // "other" presents the first person's finger for the second: one finger
      // standing in for two people.
      const slot =
        finger === "other" && isSecond
          ? demo.people.find((p) => p.id === first)?.slot ?? person.slot
          : person.slot;
      e.biometricSlot = slot;
      e.biometricScore = finger === "weak" && isSecond ? 40 : 180;
    }
    if (face !== "unread") e.faceMatched = face === "matched" || !isSecond;
    return e;
  }

  async function enter() {
    setBusy(true);
    setErr(null);
    try {
      const entrants = [entrant(first, false), entrant(second, true)].filter(
        (e): e is DoorEntrant => e !== null,
      );
      const r = await api.roomEntry(room.id, {
        deviceId: demo.deviceId,
        entrants,
        task,
        expectedMinutes: expected,
      });
      setResult({ ...r, kind: "entry" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function leave(visitId: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.roomExit(room.id, {
        deviceId: demo.deviceId,
        visitId,
        packagesTouched: touched,
      });
      setResult({ ...r, kind: "exit" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Door console" hint={room.name}>
      <div className="note" style={{ marginBottom: 12 }}>
        Stands in for the device at the door. <strong>Fingerprint and face input are simulated</strong>{" "}
        — no reader or camera is attached to this console, so it sends a slot, a score and a face
        result as the door device would. Everything else is ruled on by the real door engine. This
        room has no monitor, so footfall is reported as not evaluated.
      </div>

      {open && (
        <>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            <strong>{who(open.persons, demo)}</strong> inside for{" "}
            <span className="mono">{durationText((Date.now() - Date.parse(open.enteredAt)) / 1000)}</span>,
            expected {open.expectedMinutes}m
          </div>
          <div className="form">
            <label>Packets touched</label>
            <input
              type="number"
              min={0}
              value={touched}
              onChange={(e) => setTouched(Math.max(0, Number(e.target.value)))}
            />
          </div>
          <button
            className="primary"
            style={{ margin: "12px 0 18px" }}
            disabled={busy}
            onClick={() => void leave(open.visitId)}
          >
            {busy ? "…" : "Record the exit"}
          </button>
        </>
      )}

      <div className="form">
        <label>First person</label>
        <select value={first} onChange={(e) => setFirst(e.target.value)}>
          {demo.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({roleText(p.role)})
            </option>
          ))}
        </select>

        <label>Second person</label>
        <select value={second} onChange={(e) => setSecond(e.target.value)}>
          <option value="">nobody: one person alone</option>
          {demo.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({roleText(p.role)})
            </option>
          ))}
        </select>

        <label>Fingerprints</label>
        <select value={finger} onChange={(e) => setFinger(e.target.value as FingerChoice)}>
          <option value="own">each their own finger, score 180</option>
          <option value="weak">second one weak, score 40</option>
          <option value="other">second presents the first's finger</option>
          <option value="none">not presented</option>
        </select>

        <label>Faces</label>
        <select value={face} onChange={(e) => setFace(e.target.value as FaceChoice)}>
          <option value="unread">no face reading sent</option>
          <option value="matched">both matched</option>
          <option value="failed">second did not match</option>
        </select>

        <label>Apart</label>
        <select value={apart} onChange={(e) => setApart(Number(e.target.value))}>
          <option value={20}>20 seconds</option>
          <option value={200}>200 seconds</option>
        </select>

        <label>Task</label>
        <input type="text" value={task} onChange={(e) => setTask(e.target.value)} />

        <label>Expected</label>
        <select value={expected} onChange={(e) => setExpected(Number(e.target.value))}>
          <option value={1}>1 minute</option>
          <option value={4}>4 minutes</option>
          <option value={30}>30 minutes</option>
        </select>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
        A one-minute task is raised for review once the visit passes six minutes, with or without an
        exit.
      </div>

      <button className="primary" style={{ marginTop: 12 }} disabled={busy || !first} onClick={() => void enter()}>
        {busy ? "…" : "Present at the door"}
      </button>

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <div className={result.outcome === "granted" ? "verdict granted" : "verdict denied"}>
            {result.kind === "entry" ? "ENTRY" : "EXIT"} {result.outcome === "granted" ? "GRANTED" : "REFUSED"}
          </div>
          {result.dwellSeconds !== undefined && (
            <div className="note" style={{ marginTop: 8 }}>
              Inside for <strong>{durationText(result.dwellSeconds)}</strong>, expected{" "}
              {result.expectedMinutes}m.{" "}
              {result.dwellExceeded
                ? "That is past the limit for this task, and the visit is raised for review."
                : "Within the limit for this task."}{" "}
              Footfall: {result.footfall?.detail}.
            </div>
          )}
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
