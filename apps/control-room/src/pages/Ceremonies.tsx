import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { combineSeamShares, generateSeamLabel, type FieldShare } from "@mohar/crypto-core";
import {
  api,
  type Ceremony,
  type CeremonyStart,
  type ConfirmResult,
  type DemoOpening,
  type DutyRoster,
  type EngineCheck,
  type OfficialResult,
} from "../lib/api";
import { formatTime, relativeTime, useAsync } from "../lib/hooks";
import {
  assembleOpeningKey,
  becomeStation,
  currentStation,
  RoundNotPublished,
  unwrapOfficialShare,
  type Station,
} from "../lib/openingStation";
import { Card, Empty, ErrorNote } from "../components/ui";
import { CheckList, durationText, roleText, sha256OfFile } from "../components/CheckList";

/**
 * ── Opening ceremonies ───────────────────────────────────────────────────────
 *
 * Every opening, step by step, with what each step recorded. A ceremony's state
 * is not stored anywhere: it is the furthest step that passed, read from the
 * steps themselves, so an abandoned or refused attempt stays visible instead of
 * being overwritten by the one that worked.
 *
 * The console on the right is this browser acting as the station at the exam
 * centre. That is more than a stand-in. The officials' shares really are
 * wrapped to a key this browser holds; the control room's part really is locked
 * to a drand round and is opened here with the published value of that round;
 * and the key really is assembled on this page and checked by the ledger
 * against the commitment made when it was split. The ledger never assembles it
 * and could not.
 *
 * What is simulated is the fingerprint reader: the console sends a slot and a
 * score as the reader would, and the page says so.
 */

const RUNS_KEY = "mohar.openingRuns";
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

function loadRuns(): DemoOpening[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as DemoOpening[]) : [];
  } catch {
    return [];
  }
}

function saveRuns(list: DemoOpening[]): void {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* the console just forgets these packets on reload */
  }
}

const STEP_LABEL: Record<string, string> = {
  scan: "scanned",
  authorize: "authorised",
  identify: "two officials identified",
  confirm: "serial confirmed",
  release: "key released",
  opened: "opened",
};

function countdown(toIso: string): string {
  const ms = Date.parse(toIso) - Date.now();
  return ms > 0 ? `in ${durationText(ms / 1000)}` : `${durationText(ms / 1000)} ago`;
}

export default function Ceremonies() {
  const ceremonies = useAsync(() => api.ceremonies(), [], { pollMs: 5_000 });
  const [runs, setRuns] = useState<DemoOpening[]>(loadRuns);
  const [selected, setSelected] = useState<string | null>(() => loadRuns()[0]?.packageId ?? null);
  const [station, setStation] = useState<Station | null>(null);
  const [startsIn, setStartsIn] = useState(17);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    void currentStation().then(setStation);
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const run = runs.find((r) => r.packageId === selected) ?? null;
  const list = ceremonies.data?.ceremonies ?? [];

  async function newRun() {
    setBusy(true);
    setErr(null);
    try {
      const st = station ?? (await becomeStation());
      setStation(st);
      const r = await api.demoOpening(st.deviceId, startsIn);
      const next = [r, ...runs];
      setRuns(next);
      saveRuns(next);
      setSelected(r.packageId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ceremonies.error) return <ErrorNote error={ceremonies.error} />;

  return (
    <>
      <div className="note">
        A packet opens only when <strong>the control room's part</strong> and{" "}
        <strong>two of three officials</strong> from different institutions come together. The
        officials are identified from thirty minutes before the exam; the control room's part
        unlocks by itself fifteen minutes before, at a round of the public drand beacon, with no
        approval from anyone. The roster has to be locked first, on the{" "}
        <Link to="/rosters">Rosters</Link> page. A ceremony that is started and has not released its
        key by the scheduled minute is raised on the <Link to="/alerts">Alerts</Link> page.
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="toolbar">
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {station ? (
            <>
              This browser is station <span className="mono">{station.deviceId.slice(0, 8)}…</span>
            </>
          ) : (
            "This browser becomes the station when the first packet is made"
          )}
        </span>
        <div className="spacer" />
        <button onClick={() => void ceremonies.refresh()}>Refresh</button>
        <label htmlFor="starts-in">Exam starts in</label>
        <select id="starts-in" value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))}>
          <option value={17}>17 minutes: opens in 2</option>
          <option value={20}>20 minutes: opens in 5</option>
          <option value={45}>45 minutes: too early to begin</option>
        </select>
        <button className="primary" disabled={busy} onClick={() => void newRun()}>
          {busy ? "Preparing…" : "New packet due to open"}
        </button>
      </div>

      <div className="grid main-side">
        <div style={{ display: "grid", gap: 14 }}>
          {runs.length > 0 && (
            <Card title="Packets this browser can open" hint="it holds their label" flush>
              <table>
                <thead>
                  <tr>
                    <th>Packet</th>
                    <th>Ceremony from</th>
                    <th>Opens</th>
                    <th>Exam starts</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.packageId}
                      className="clickable"
                      onClick={() => setSelected(r.packageId)}
                      style={r.packageId === selected ? { background: "var(--surface-2)" } : undefined}
                    >
                      <td>
                        <div className="mono" style={{ fontSize: 12 }}>{r.serial}</div>
                        <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{r.centreCode}</div>
                      </td>
                      <td className="mono">
                        {countdown(new Date(Date.parse(r.examStartsAt) - 30 * 60_000).toISOString())}
                      </td>
                      <td className="mono">
                        {countdown(new Date(Date.parse(r.examStartsAt) - 15 * 60_000).toISOString())}
                      </td>
                      <td className="mono" title={formatTime(r.examStartsAt)}>
                        {countdown(r.examStartsAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title="Ceremonies" hint="every attempt, newest first" flush>
            {list.length === 0 ? (
              <Empty>No opening has been started.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Packet</th>
                    <th>Reached</th>
                    <th>Officials</th>
                    <th className="num">Refused steps</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <CeremonyRow
                      key={c.id}
                      ceremony={c}
                      run={runs.find((r) => r.packageId === c.packageId) ?? null}
                      open={open === c.id}
                      onToggle={() => setOpen(open === c.id ? null : c.id)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        {run && station ? (
          <StationConsole run={run} station={station} onDone={() => void ceremonies.refresh()} key={run.packageId} />
        ) : (
          <Card title="Station console">
            <Empty>
              {runs.length === 0
                ? 'Press "New packet due to open". It makes a packet at its centre, three officials and an unlocked roster.'
                : "Select a packet to open it."}
            </Empty>
          </Card>
        )}
      </div>
    </>
  );
}

function CeremonyRow({
  ceremony: c,
  run,
  open,
  onToggle,
}: {
  ceremony: Ceremony;
  run: DemoOpening | null;
  open: boolean;
  onToggle: () => void;
}) {
  const refused = c.steps.filter((s) => s.outcome === "refused" && s.step !== "incomplete").length;
  const incomplete = c.steps.some((s) => s.step === "incomplete");
  const name = (personId: string) =>
    run?.officials.find((o) => o.id === personId)?.name ?? `${personId.slice(0, 8)}…`;
  return (
    <Fragment>
      <tr className="clickable" onClick={onToggle}>
        <td>
          <div className="mono" style={{ fontSize: 12 }}>{c.packetSerial ?? c.packageId.slice(0, 8)}</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{c.centreCode}</div>
        </td>
        <td>
          <span className={`badge ${c.reached === "opened" || c.reached === "release" ? "ok" : c.reached ? "info" : "critical"}`}>
            {c.reached ? STEP_LABEL[c.reached] : "stopped at the scan"}
          </span>
          {incomplete && (
            <span className="badge high" style={{ marginLeft: 6 }}>
              not released by its time
            </span>
          )}
        </td>
        <td style={{ fontSize: 12 }}>
          {c.officials.length === 0
            ? "—"
            : c.officials.map((o) => `${name(o.personId)} (${roleText(o.role)})`).join(", ")}
        </td>
        <td className="num mono">{refused}</td>
        <td className="mono" title={formatTime(c.startedAt)}>{relativeTime(c.startedAt)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: "8px 12px" }}>
            {c.steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <span className="mono">{s.step}</span>{" "}
                  <span className={`badge ${s.outcome === "passed" ? "ok" : "critical"}`}>
                    {s.step === "incomplete" ? "raised" : s.outcome}
                  </span>{" "}
                  <span style={{ color: "var(--text-faint)" }}>{formatTime(s.recordedAt)}</span>
                </div>
                <CheckList checks={s.checks} />
              </div>
            ))}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

type LabelChoice = "this" | "other" | "none";
type FingerChoice = "match" | "weak" | "none" | "wrong";

interface Verdict {
  title: string;
  ok: boolean;
  denyReasons: string[];
  checks: EngineCheck[];
}

function StationConsole({ run, station, onDone }: { run: DemoOpening; station: Station; onDone: () => void }) {
  const roster = useAsync(() => api.rosters(run.centreId), [run.centreId], { pollMs: 5_000 });
  const [start, setStart] = useState<CeremonyStart | null>(null);
  const [identified, setIdentified] = useState<{ personId: string; role: string }[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmResult | null>(null);
  const [released, setReleased] = useState(false);
  const [opened, setOpened] = useState(false);

  // The unwrapped shares. Held in a ref, in memory, for the length of this
  // ceremony: never in state that renders, never in storage.
  const shares = useRef<FieldShare[]>([]);

  const [labelChoice, setLabelChoice] = useState<LabelChoice>("this");
  const [personId, setPersonId] = useState(run.officials[0]?.id ?? "");
  const [finger, setFinger] = useState<FingerChoice>("match");
  const [serial, setSerial] = useState(run.serial);
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const r: DutyRoster | undefined = roster.data?.rosters[0];
  const issued = r?.issued.find((k) => k.packageId === run.packageId) ?? null;
  const thisStation = issued ? issued.stationDeviceId === station.deviceId : true;
  const opensAt = new Date(Date.parse(run.examStartsAt) - 15 * 60_000).toISOString();
  const msToOpen = Date.parse(opensAt) - Date.now();

  const ceremonyOk = start?.outcome === "passed";
  const stage = !ceremonyOk
    ? "scan"
    : identified.length < 2
      ? "identify"
      : !confirmed || confirmed.outcome !== "passed"
        ? "confirm"
        : !released
          ? "release"
          : !opened
            ? "opened"
            : "done";

  function reset() {
    shares.current = [];
    setStart(null);
    setIdentified([]);
    setConfirmed(null);
    setReleased(false);
    setOpened(false);
  }

  async function act(fn: () => Promise<Verdict | null>) {
    setBusy(true);
    setErr(null);
    try {
      const v = await fn();
      if (v) setVerdict(v);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setVerdict(null);
    } finally {
      setBusy(false);
    }
  }

  const doScan = () =>
    act(async () => {
      // A new scan is a new ceremony; whatever the last one held is dropped.
      reset();
      let seam: { seamIdRead?: string; seamSecretHex?: string } = {};
      if (labelChoice === "this") {
        const secret = combineSeamShares(fromHex(run.label.shareAHex), fromHex(run.label.shareBHex));
        seam = { seamIdRead: run.label.seamId, seamSecretHex: toHex(secret) };
      } else if (labelChoice === "other") {
        const other = generateSeamLabel();
        seam = { seamIdRead: other.seamId, seamSecretHex: toHex(other.seamSecret) };
      }
      const s = await api.startCeremony({ packageId: run.packageId, deviceId: station.deviceId, ...seam });
      setStart(s);
      return {
        title: s.outcome === "passed" ? "SCAN AND AUTHORISATION PASSED" : "CEREMONY STOPPED",
        ok: s.outcome === "passed",
        denyReasons: [...s.scan.denyReasons, ...s.authorize.denyReasons],
        checks: [...s.scan.checks, ...s.authorize.checks],
      };
    });

  const doOfficial = () =>
    act(async () => {
      if (!start) return null;
      const person = run.officials.find((o) => o.id === personId);
      if (!person) return null;
      // "wrong" presents a finger registered to one of the other officials.
      const slot =
        finger === "wrong"
          ? run.officials.find((o) => o.id !== personId)?.slot ?? person.slot
          : person.slot;
      const res: OfficialResult = await api.ceremonyOfficial(station.deviceId, start.ceremonyId, {
        personId,
        ...(finger === "none" ? {} : { biometricSlot: slot, biometricScore: finger === "weak" ? 40 : 181 }),
      });
      if (res.outcome === "passed" && res.share) {
        // The share is unwrapped here, by this browser's own key, and goes
        // nowhere but the ref above.
        shares.current = [...shares.current, await unwrapOfficialShare(station, run.packageId, res)];
        const next = [...identified, { personId, role: person.role }];
        setIdentified(next);
        const other = run.officials.find((o) => !next.some((n) => n.personId === o.id));
        if (other) setPersonId(other.id);
      }
      return {
        title:
          res.outcome === "passed"
            ? `OFFICIAL ${res.identified} — CONFIRMED`
            : "OFFICIAL NOT CONFIRMED",
        ok: res.outcome === "passed",
        denyReasons: res.denyReasons,
        checks: res.checks,
      };
    });

  const doConfirm = () =>
    act(async () => {
      if (!start) return null;
      const res = await api.ceremonyConfirm(station.deviceId, start.ceremonyId, serial);
      setConfirmed(res);
      return {
        title: res.outcome === "passed" ? "SERIAL CONFIRMED" : "SERIAL REFUSED",
        ok: res.outcome === "passed",
        denyReasons: res.denyReasons,
        checks: res.checks,
      };
    });

  const doRelease = () =>
    act(async () => {
      if (!start || !confirmed?.envelope || !confirmed.commitments) return null;
      let keyHex: string;
      try {
        keyHex = await assembleOpeningKey(confirmed.envelope, shares.current, confirmed.commitments);
      } catch (e) {
        if (e instanceof RoundNotPublished) {
          // Nothing was sent to the ledger: there is no key to present, because
          // the value that opens the control room's part does not exist yet.
          return {
            title: "THE CONTROL ROOM'S PART IS STILL LOCKED",
            ok: false,
            denyReasons: ["control_part_still_locked"],
            checks: [
              {
                check: "round_published",
                passed: false,
                evidence: `${(e as Error).message}. It is due ${countdown(opensAt)}. Nobody can shorten this wait.`,
              },
            ],
          };
        }
        throw e;
      }
      const res = await api.ceremonyRelease(station.deviceId, start.ceremonyId, keyHex);
      if (res.outcome === "granted") {
        setReleased(true);
        shares.current.forEach((s) => s.share.fill(0));
        shares.current = [];
      }
      return {
        title: res.outcome === "granted" ? "GRANTED — THE PACKET MAY BE OPENED" : "RELEASE REFUSED",
        ok: res.outcome === "granted",
        denyReasons: res.denyReasons,
        checks: res.checks,
      };
    });

  const doOpened = () =>
    act(async () => {
      if (!start || !photo) return null;
      const res = await api.ceremonyOpened(station.deviceId, start.ceremonyId, await sha256OfFile(photo), 2);
      if (res.outcome === "opened") setOpened(true);
      return {
        title: res.outcome === "opened" ? "OPENING RECORDED" : "OPENING NOT RECORDED",
        ok: res.outcome === "opened",
        denyReasons: [],
        checks: [],
      };
    });

  const name = (id: string) => run.officials.find((o) => o.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card title="Station console" hint={`${run.serial} · ${run.centreCode}`}>
      <div className="note" style={{ marginBottom: 12 }}>
        This browser is the station. The shares are unwrapped and the key is assembled here, with
        the real beacon. <strong>Fingerprint input is simulated</strong> — no reader is attached, so
        the console sends a slot and score as the reader would.
      </div>

      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>Roster</dt>
        <dd>
          {issued ? (
            `locked · key issued, round ${issued.drandRound}`
          ) : (
            <>
              not locked — <Link to="/rosters">lock it on the Rosters page</Link>
            </>
          )}
        </dd>
        <dt>Control part</dt>
        <dd>{msToOpen > 0 ? `locked, opens in ${durationText(msToOpen / 1000)}` : "its round has been published"}</dd>
        <dt>Officials</dt>
        <dd>
          {identified.length === 0
            ? "none identified"
            : identified.map((_, i) => `Official ${i + 1} — confirmed`).join(" · ")}
        </dd>
      </dl>

      {!thisStation && (
        <div className="banner" style={{ marginBottom: 12 }}>
          This packet's shares were wrapped to a different station. This browser cannot unwrap them.
        </div>
      )}

      {stage === "scan" && (
        <>
          <div className="form">
            <label>Label scanned</label>
            <select value={labelChoice} onChange={(e) => setLabelChoice(e.target.value as LabelChoice)}>
              <option value="this">this packet's label, both codes</option>
              <option value="other">a label from another packet</option>
              <option value="none">not scanned</option>
            </select>
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => void doScan()}>
            {busy ? "…" : "Scan the packet and ask to begin"}
          </button>
        </>
      )}

      {stage === "identify" && (
        <>
          <div className="form">
            <label>At the reader</label>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              {run.officials.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({roleText(o.role)})
                </option>
              ))}
            </select>
            <label>Fingerprint</label>
            <select value={finger} onChange={(e) => setFinger(e.target.value as FingerChoice)}>
              <option value="match">their own finger, score 181</option>
              <option value="weak">weak match, score 40</option>
              <option value="wrong">another official's finger</option>
              <option value="none">not presented</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
            The second official must present within 120 seconds of the first. Their share is handed
            to this station only when the engine has confirmed them, and is never shown.
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => void doOfficial()}>
            {busy ? "…" : `Identify official ${identified.length + 1}`}
          </button>
        </>
      )}

      {stage === "confirm" && (
        <>
          <div className="form">
            <label>Serial typed</label>
            <input type="text" value={serial} onChange={(e) => setSerial(e.target.value)} />
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => void doConfirm()}>
            {busy ? "…" : "Confirm the packet serial"}
          </button>
        </>
      )}

      {stage === "release" && (
        <>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            {name(identified[0]?.personId ?? "")} and {name(identified[1]?.personId ?? "")} are
            confirmed and the serial matches. What is left is the control room's part, which{" "}
            {msToOpen > 0 ? (
              <>
                opens <strong className="mono">{countdown(opensAt)}</strong>.
              </>
            ) : (
              "can be opened now."
            )}
          </div>
          <button className="primary" disabled={busy} onClick={() => void doRelease()}>
            {busy ? "Fetching the round…" : msToOpen > 0 ? "Try to open it now" : "Fetch the round and assemble the key"}
          </button>
        </>
      )}

      {stage === "opened" && (
        <>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            The key is released. Open the packet before the candidates, photograph it, and record the
            opening with that photograph.
          </div>
          <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          <div>
            <button
              className="primary"
              style={{ marginTop: 12 }}
              disabled={busy || !photo}
              onClick={() => void doOpened()}
            >
              {busy ? "…" : "Record the opening"}
            </button>
          </div>
        </>
      )}

      {stage === "done" && <div className="verdict granted">PACKET OPENED</div>}

      {stage !== "scan" && stage !== "done" && (
        <button style={{ marginTop: 10 }} disabled={busy} onClick={reset}>
          Abandon and start again
        </button>
      )}

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}

      {verdict && (
        <div style={{ marginTop: 14 }}>
          <div className={verdict.ok ? "verdict granted" : "verdict denied"}>{verdict.title}</div>
          {verdict.denyReasons.length > 0 && (
            <div style={{ fontSize: 12, margin: "10px 0 6px", color: "var(--text-dim)" }}>
              Refused for: <span className="mono">{verdict.denyReasons.join(", ")}</span>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <CheckList checks={verdict.checks} />
          </div>
        </div>
      )}
    </Card>
  );
}
