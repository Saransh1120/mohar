import { useEffect, useRef, useState } from "react";
import { api, type CallRecord } from "../lib/api";
import { OperatorCall, PhoneCall, type CallStatus } from "../lib/overrideCall";
import { useAsync, relativeTime } from "../lib/hooks";
import { CheckList } from "./CheckList";

/**
 * The two ends of an override's video call, as panels.
 *
 * Neither panel decides anything. The operator's shows the phone's camera and
 * what the ledger has on record about this operator's call; whether that is
 * enough for an approval is ruled by the ledger when the approval is made.
 */

const PHASE_BADGE: Record<CallStatus["phase"], string> = {
  idle: "neutral",
  starting: "info",
  waiting: "info",
  connecting: "info",
  live: "ok",
  failed: "critical",
  ended: "neutral",
};

function Video({ stream, muted, label }: { stream: MediaStream | null; muted: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      aria-label={label}
      style={{
        width: "100%",
        maxWidth: 420,
        aspectRatio: "4 / 3",
        background: "#000",
        borderRadius: 6,
        display: stream ? "block" : "none",
      }}
    />
  );
}

/** An operator's end: opens the call, shows the phone's camera, reads back the record. */
export function OperatorCallPanel({ overrideId, accountId }: { overrideId: string; accountId: string | null }) {
  const [status, setStatus] = useState<CallStatus>({ phase: "idle", detail: "" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const call = useRef<OperatorCall | null>(null);
  const record = useAsync<CallRecord>(() => api.overrideCall.record(overrideId), [overrideId], { pollMs: 4000 });

  useEffect(() => () => void call.current?.stop(), []);

  async function open() {
    setErr(null);
    const c = new OperatorCall(overrideId, setStatus, setStream);
    call.current = c;
    try {
      await c.start();
    } catch (e) {
      setErr((e as Error).message);
      setStatus({ phase: "failed", detail: "The call could not be opened." });
    }
  }
  async function close() {
    await call.current?.stop();
    call.current = null;
    void record.refresh();
  }

  const active = status.phase !== "idle" && status.phase !== "ended" && status.phase !== "failed";
  const mine = record.data?.operators.find((o) => o.accountId === accountId);

  return (
    <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>Video call with the phone that made this request</strong>
        {status.phase !== "idle" && <span className={`badge ${PHASE_BADGE[status.phase]}`}>{status.phase}</span>}
        <div className="spacer" />
        {active ? (
          <button onClick={() => void close()}>Close the call</button>
        ) : (
          <button className="primary" onClick={() => void open()}>
            Open the call
          </button>
        )}
      </div>
      {status.detail && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
          {status.detail}
          {status.framesDecoded !== undefined && (
            <span className="mono"> {status.framesDecoded} frames decoded.</span>
          )}
        </div>
      )}
      {err && <div className="banner" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
      <div style={{ marginTop: 8 }}>
        <Video stream={stream} muted={false} label="The phone's camera" />
      </div>

      <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
        What the ledger has on record about your call. An approval is accepted only when all three
        hold. The ledger does not see the picture: it carried the call's set-up and has each end's
        own report that video was flowing.
      </div>
      {record.error ? (
        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>The call's record could not be read.</div>
      ) : mine ? (
        <CheckList checks={mine.checks} />
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
          Nothing yet: you have not opened a call on this request.
        </div>
      )}
      {(record.data?.events.length ?? 0) > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: "var(--text-faint)", cursor: "pointer" }}>
            Everything recorded about this call ({record.data!.events.length})
          </summary>
          <ul className="act-facts">
            {record.data!.events.map((e, i) => (
              <li key={i}>
                {e.party === "field" ? "the phone" : (e.accountName ?? "an operator")} · {e.event.replace(/_/g, " ")}
                {e.party === "field" && e.accountName ? ` (to ${e.accountName})` : ""}
                {typeof e.detail.framesDecoded === "number" ? ` · ${e.detail.framesDecoded} frames` : ""}
                {" · "}
                {relativeTime(e.recordedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The phone's end, for a console that stands in for the handheld. */
export function PhoneCallPanel({ overrideId, deviceId }: { overrideId: string; deviceId: string }) {
  const [status, setStatus] = useState<CallStatus>({ phase: "idle", detail: "" });
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const call = useRef<PhoneCall | null>(null);

  useEffect(() => () => void call.current?.stop(), []);

  async function open() {
    setErr(null);
    const c = new PhoneCall(overrideId, deviceId, setStatus, setPreview);
    call.current = c;
    try {
      await c.start();
    } catch (e) {
      await c.stop();
      setErr((e as Error).message);
      setStatus({ phase: "failed", detail: "The call could not be opened." });
    }
  }
  async function close() {
    await call.current?.stop();
    call.current = null;
  }

  const active = status.phase !== "idle" && status.phase !== "ended" && status.phase !== "failed";

  return (
    <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>Show the packet to the control room</strong>
        {status.phase !== "idle" && <span className={`badge ${PHASE_BADGE[status.phase]}`}>{status.phase}</span>}
        <div className="spacer" />
        {active ? (
          <button onClick={() => void close()}>Close the call</button>
        ) : (
          <button className="primary" onClick={() => void open()}>
            Open the camera and call
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
        {status.detail ||
          "Two operators each have to see the packet, its label and both officers on this call before they can approve."}
      </div>
      {err && <div className="banner" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
      <div style={{ marginTop: 8 }}>
        <Video stream={preview} muted label="This device's camera" />
      </div>
    </div>
  );
}
