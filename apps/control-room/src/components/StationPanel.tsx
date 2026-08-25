import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { api, type RawEvent } from "../lib/api";
import {
  station,
  loadStationUrl,
  saveStationUrl,
  normalise,
  enrolInstruction,
  type StationStatus,
} from "../lib/station";

/**
 * Drive the fingerprint reader from here rather than from a serial console.
 *
 * Enrolment is not a factory step — it happens per centre, per exam cycle, and
 * again the morning somebody's hands are too dry to read. A procedure that needs
 * a laptop, a USB cable and an IDE is a procedure that gets skipped, and skipped
 * enrolment is how the two-person rule quietly becomes a one-person rule.
 *
 * The panel shows the reader's own state and relays instructions to whoever is
 * standing at it. It signs nothing and records nothing: the evidence still comes
 * from the station's key, and this is a remote control.
 */
export default function StationPanel({ onEnrolled }: { onEnrolled?: () => void }) {
  const [url, setUrl] = useState(() => loadStationUrl());
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [ledgerUrl, setLedgerUrl] = useState("");
  const [ledgerSaved, setLedgerSaved] = useState(false);

  const lastEnrolState = useRef<string>("");

  /**
   * When the ledger last heard from a station, whatever address this panel is
   * dialling.
   *
   * "Could not reach 10.103.145.182" has two very different causes that look
   * identical from here: the address is stale, or the board is off. The chain
   * settles it — the station heartbeats every thirty seconds, so a heartbeat a
   * minute ago means the device is alive and the address is wrong, and silence
   * for an hour means the address is beside the point. Without this the
   * operator retypes IP addresses at a board that is not powered.
   */
  const [lastHeard, setLastHeard] = useState<{ at: string; deviceId: string } | null>(null);
  const [heardChecked, setHeardChecked] = useState(false);

  useEffect(() => {
    if (!error) return;
    let stopped = false;
    void (async () => {
      try {
        const health = await api.health();
        const tip = Number(health.chainTip?.seq ?? 0);
        const { events } = await api.rawEvents(String(Math.max(0, tip - 400)), 400);
        if (stopped) return;
        const beats = (events as RawEvent[]).filter((e) => e.kind === "MONITOR_HEARTBEAT");
        const last = beats[beats.length - 1];
        setLastHeard(last ? { at: last.body.occurredAt, deviceId: last.body.actorDeviceId } : null);
      } catch {
        // The ledger being unreachable too is its own visible failure elsewhere.
      } finally {
        if (!stopped) setHeardChecked(true);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [error]);

  // Held in a ref rather than closed over. The parent passes this inline, so it
  // is a new function every render — depending on it directly would change
  // `poll`'s identity on every render, restart the interval effect, and leave
  // the panel polling in a tight loop instead of on its timer.
  const onEnrolledRef = useRef(onEnrolled);
  useEffect(() => {
    onEnrolledRef.current = onEnrolled;
  }, [onEnrolled]);

  const poll = useCallback(async () => {
    const base = normalise(url);
    if (!base) return;
    try {
      const s = await station.status(base);
      setStatus(s);
      // Show what the device is actually trying to reach, not what somebody
      // assumed it was. Only seed the field while it is untouched.
      setLedgerUrl((cur) => (cur === "" ? s.ledgerUrl ?? "" : cur));
      setConnected(true);
      setError(null);

      // Tell the page a template appeared, so the slot register can refresh and
      // the operator is not left wondering whether it took.
      if (s.enrol.state === "stored" && lastEnrolState.current !== "stored") {
        onEnrolledRef.current?.();
      }
      lastEnrolState.current = s.enrol.state;
    } catch (err) {
      setConnected(false);
      setError((err as Error).message);
    }
  }, [url]);

  // Fast while an enrolment is running, because the instruction on screen is
  // what the person at the reader is following; slow otherwise.
  useEffect(() => {
    if (!normalise(url)) return;
    void poll();
    const active =
      status?.enrol.state === "place_finger" ||
      status?.enrol.state === "lift_finger" ||
      status?.enrol.state === "place_again";
    const t = setInterval(() => void poll(), active ? 500 : 3000);
    return () => clearInterval(t);
  }, [url, poll, status?.enrol.state]);

  const connect = () => {
    const base = normalise(url);
    if (!base) return;
    saveStationUrl(base);
    setUrl(base);
    void poll();
  };

  const beginEnrol = async () => {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > 127) {
      setError("Slot must be a whole number between 1 and 127.");
      return;
    }
    // Clear the last failure before starting. Leaving it on screen while a new
    // enrolment is running reads as though the new attempt failed instantly.
    setError(null);
    setBusy(true);
    try {
      await station.enrol(normalise(url), n);
      await poll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const e = status?.enrol;
  const running =
    e?.state === "place_finger" || e?.state === "lift_finger" || e?.state === "place_again";

  return (
    <Card
      title="Fingerprint station"
      hint="Enrol and remove templates without touching the serial console"
    >
      <div className="stn-connect">
        <input
          className="wit-select"
          placeholder="10.91.155.42  — the address the station prints at boot"
          value={url}
          onChange={(ev) => setUrl(ev.target.value)}
          onKeyDown={(ev) => ev.key === "Enter" && connect()}
        />
        <button className="wit-btn" onClick={connect}>
          Connect
        </button>
      </div>

      {status && connected && (
        <div className="stn-state">
          <span className={`stn-dot ${status.reader ? "ok" : "no"}`} />
          <span>
            {status.reader ? "reader ready" : "no reader"} · {status.templates} of{" "}
            {status.capacity} templates
          </span>
          <span className="wit-note" style={{ margin: 0 }}>
            slots under {status.observerSlotMin} are the superintendent
          </span>
        </div>
      )}

      {error && <div className="wit-error">{error}</div>}

      {error && heardChecked && (
        <div className="wit-note" style={{ marginTop: 6 }}>
          {!lastHeard ? (
            <>
              The ledger has no heartbeat from any station in the recent chain either, so the
              address is probably not the problem — check the board is powered and on this
              network.
            </>
          ) : (
            (() => {
              const ageMs = Date.now() - Date.parse(lastHeard.at);
              const mins = Math.round(ageMs / 60_000);
              // A station heartbeats every thirty seconds. Two missed in a row
              // is a device that has stopped, not a slow network.
              const stale = ageMs > 120_000;
              return stale ? (
                <>
                  The ledger last heard from station <code>{lastHeard.deviceId.slice(0, 8)}</code>{" "}
                  {mins < 60 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`} ago, and it
                  reports every 30 seconds. The board is almost certainly powered off or off this
                  network — a different address will not help until it is back.
                </>
              ) : (
                <>
                  The ledger heard from station <code>{lastHeard.deviceId.slice(0, 8)}</code> less
                  than two minutes ago, so the device is alive and this address is wrong. It
                  prints its own address at boot.
                </>
              );
            })()
          )}
        </div>
      )}

      {connected && (
        <>
          <div className="stn-enrol">
            <input
              className="wit-select"
              inputMode="numeric"
              placeholder="slot 1–127"
              value={slot}
              onChange={(ev) => setSlot(ev.target.value)}
              disabled={running}
            />
            <button
              className="wit-btn"
              onClick={() => void beginEnrol()}
              disabled={busy || running || !status?.reader}
            >
              Enrol a finger
            </button>
            {running && (
              <button
                className="wit-btn ghost"
                onClick={() => void station.cancel(normalise(url)).then(poll)}
              >
                Cancel
              </button>
            )}
            <button
              className="wit-btn ghost"
              onClick={() => {
                const n = Number(slot);
                if (!Number.isInteger(n) || n < 1) return;
                if (!window.confirm(`Delete the template in slot ${n} from the reader?`)) return;
                void station.deleteSlot(normalise(url), n).then(poll).catch((err) =>
                  setError((err as Error).message),
                );
              }}
              disabled={running}
            >
              Delete slot
            </button>
          </div>

          {e && e.state !== "idle" && (
            <div className={`stn-step ${e.state}`}>
              <div className="stn-step-head">
                {enrolInstruction(e.state)}
                {e.slot > 0 && <span className="fp-meta">slot {e.slot}</span>}
              </div>
              <div className="wit-note">{e.message}</div>
            </div>
          )}

          <div className="stn-ledger">
            <label>
              <span>Where this station sends its records</span>
              <div className="stn-connect">
                <input
                  className="wit-select"
                  placeholder="http://192.168.0.10:8081"
                  value={ledgerUrl}
                  onChange={(ev) => {
                    setLedgerUrl(ev.target.value);
                    setLedgerSaved(false);
                  }}
                />
                <button
                  className="wit-btn ghost"
                  onClick={() => {
                    void station
                      .setLedger(normalise(url), ledgerUrl.trim())
                      .then(() => {
                        setLedgerSaved(true);
                        return poll();
                      })
                      .catch((err) => setError((err as Error).message));
                  }}
                  disabled={!ledgerUrl.trim()}
                >
                  Set
                </button>
              </div>
            </label>
            <div className="wit-note">
              {ledgerSaved
                ? "Saved on the device and kept across reboots. Buffered records will drain to it."
                : "Change this when the network moves — a hotspot hands out a new subnet every restart, and the address baked into flash is wrong from then on. No re-flash needed."}
            </div>
          </div>

          <div className="wit-note">
            The template never leaves the reader. What is stored here is a slot number;
            who that slot belongs to is registered separately, below — and until it is,
            the access engine reports the slot as unmapped, which is a finding rather
            than a fault.
          </div>
        </>
      )}

      {!connected && !error && (
        <div className="wit-note">
          The station prints its address on the serial console at boot, and records it in
          the activity feed as <code>station_online</code>. It must be on the same network
          as this machine.
        </div>
      )}
    </Card>
  );
}
