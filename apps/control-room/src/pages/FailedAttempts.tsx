import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AccessAttempt, type RawEvent } from "../lib/api";
import { formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import { useEvidence } from "../lib/evidence";
import type { ChainEvent } from "../lib/useEventStream";
import { frameFileName, verifyFrame, type StoredFrame, type VerifyResult } from "../lib/frameStore";

/**
 * ── Failed unlock attempts ───────────────────────────────────────────────────
 *
 * One page, one question: who was refused, and is there a photograph of it.
 *
 * A separate page rather than a filter on Activity, because a refusal buried in
 * a feed of ninety routine events is a refusal nobody reads — and these are the
 * records most likely to be wanted after the fact.
 *
 * Two things a reader has to know before trusting a card:
 *
 *   • **The photograph is of this terminal.** The ESP32 at the station reads the
 *     finger and has no camera fitted; the camera is this laptop's. So the face
 *     in the frame is whoever was in front of *this* machine when the refusal
 *     came back, which is the person who was refused only if the station and
 *     this desk are the same place. Anything stronger needs a camera on the
 *     station, and the card never implies more than this.
 *   • **A card with no photograph is not a weaker record.** It means the camera
 *     was off, this browser was not enrolled, or the refusal predates the
 *     feature. The refusal itself is no less real, and the card says which.
 */

/** Codes the reader raises when it refuses, and what they say in plain words. */
const REASON_TEXT: Record<string, string> = {
  biometric_no_match: "NO ENROLLED MATCH",
  biometric_low_confidence: "LOW CONFIDENCE",
  no_enrolled_match: "NO ENROLLED MATCH",
  low_confidence: "LOW CONFIDENCE",
  access_denied: "ACCESS DENIED",
  invalid_attempt: "INVALID ATTEMPT",
};

const say = (r: string): string => REASON_TEXT[r] ?? r.replace(/_/g, " ").toUpperCase();

interface Failure {
  /** Stable across refresh and redelivery, so a card is never duplicated. */
  key: string;
  source: "decision" | "station";
  /** The device that was refused, or that read the finger. */
  stationId: string;
  occurredAt: string;
  reasons: string[];
  /** The chain event, where there is one. Refused decisions have none. */
  eventId: string | null;
  seq: string | null;
  attemptId: string | null;
  centreCode: string | null;
  stage: string | null;
}

const fromAttempt = (a: AccessAttempt): Failure => ({
  key: `attempt:${a.id}`,
  source: "decision",
  stationId: a.actorDeviceId,
  occurredAt: a.decidedAt || a.attemptedAt,
  reasons: a.denyReasons?.length ? a.denyReasons : ["access_denied"],
  eventId: a.eventId,
  seq: a.seq,
  attemptId: a.id,
  centreCode: a.centreCode,
  stage: a.stage,
});

const fromException = (e: RawEvent): Failure => ({
  key: `exception:${e.body.id}`,
  source: "station",
  stationId: e.body.actorDeviceId,
  occurredAt: e.body.occurredAt,
  reasons: [String(e.body.payload["code"] ?? "invalid_attempt")],
  eventId: e.body.id,
  seq: e.seq,
  attemptId: null,
  centreCode: null,
  stage: null,
});

/** How far back to read on first load. The chain is long; the page is not. */
const BACKFILL = 1000;

export default function FailedAttempts() {
  const {
    frames,
    stream,
    subscribe,
    cameraOn,
    cameraError,
    startCamera,
    stopCamera,
    attachPreview,
    identity,
    pairing,
    pair,
    forget,
    refreshFrames,
    lastError,
    busy,
  } = useEvidence();

  /**
   * The camera lives with the provider, not with the Ceremony page.
   *
   * It is armed from here because this is the page whose whole purpose depends
   * on it: an operator watching for refusals should not have to know that the
   * camera belongs to a different screen. Arming it here also leaves the
   * Ceremony page exactly as it was.
   */
  const previewRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    attachPreview(previewRef.current);
    return () => attachPreview(null);
  }, [attachPreview]);

  const [failures, setFailures] = useState<Failure[]>([]);
  const [verified, setVerified] = useState<Record<string, VerifyResult>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const seenRef = useRef<Set<string>>(new Set());
  const readyRef = useRef(false);

  /**
   * Merge without duplicating.
   *
   * The same refusal arrives more than once — in the backfill and again on the
   * stream, or twice on the stream after a reconnect replays from the last id.
   * Keying on the event or attempt id makes redelivery harmless, which is what
   * lets the reconnect logic stay as simple as it is.
   */
  const absorb = useCallback((incoming: Failure[]) => {
    const unseen = incoming.filter((f) => !seenRef.current.has(f.key));
    if (unseen.length === 0) return;
    for (const f of unseen) seenRef.current.add(f.key);
    setFailures((prev) =>
      [...unseen, ...prev].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    );
    // Only mark things new once the backfill has settled, or every card would
    // be badged NEW on first paint and the badge would mean nothing.
    if (!readyRef.current) return;
    const keys = unseen.map((f) => f.key);
    setFresh((s) => new Set([...s, ...keys]));
    window.setTimeout(
      () => setFresh((s) => new Set([...s].filter((k) => !keys.includes(k)))),
      25_000,
    );
  }, []);

  /**
   * Refused decisions are not in the chain.
   *
   * `/access/request` records the attempt and returns; appending an
   * `ACCESS_DENIED` would need a signing identity the service deliberately does
   * not have. So the stream cannot carry them, and this read is how they
   * arrive. The stream *does* carry the `ACCESS_FRAME` committed when a refusal
   * is photographed, and that is the cue to come back and read the attempt.
   */
  const loadDenied = useCallback(async () => {
    const { attempts } = await api.attempts({ outcome: "denied", limit: 100 });
    absorb(attempts.map(fromAttempt));
  }, [absorb]);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const health = await api.health();
        const tip = Number(health.chainTip?.seq ?? 0);
        const from = String(Math.max(0, tip - BACKFILL));
        const [{ events }] = await Promise.all([api.rawEvents(from, 1000), loadDenied()]);
        if (stopped) return;
        absorb(
          (events as RawEvent[])
            .filter(
              (e) =>
                e.kind === "EXCEPTION_RAISED" &&
                String(e.body.payload["code"] ?? "").startsWith("biometric_"),
            )
            .map(fromException),
        );
      } catch (err) {
        if (!stopped) setError(err as Error);
      } finally {
        if (!stopped) {
          setLoading(false);
          readyRef.current = true;
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [absorb, loadDenied]);

  /**
   * Live failures, through the provider's stream.
   *
   * The provider holds the app's one `EventSource`; this subscribes to it.
   * Opening a second here would double every delivery and give the browser two
   * connections to reconnect on a dropped link.
   *
   * An `ACCESS_FRAME` is the cue to re-read, not a card of its own: it says a
   * photograph was committed for a refusal, and the refusal it names has to be
   * fetched because refused decisions are not in the chain.
   */
  useEffect(
    () =>
      subscribe((e: ChainEvent) => {
        const body = e.body as unknown as RawEvent["body"];
        if (e.kind === "EXCEPTION_RAISED") {
          const code = String(body.payload["code"] ?? "");
          if (code.startsWith("biometric_")) {
            absorb([fromException({ ...e, body } as unknown as RawEvent)]);
          }
          return;
        }
        if (e.kind === "ACCESS_FRAME") {
          void loadDenied();
          void refreshFrames();
        }
      }),
    [subscribe, absorb, loadDenied, refreshFrames],
  );

  // ── images ────────────────────────────────────────────────────────────────

  const refusalFrames = useMemo(() => frames.filter((f) => f.kind === "refusal"), [frames]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of refusalFrames) next[f.id] = URL.createObjectURL(f.blob);
    setUrls(next);
    return () => {
      for (const u of Object.values(next)) URL.revokeObjectURL(u);
    };
  }, [refusalFrames]);

  const frameFor = useCallback(
    (f: Failure): StoredFrame | undefined =>
      refusalFrames.find(
        (fr) =>
          (f.attemptId && fr.boundEventId === f.attemptId) ||
          (f.eventId && fr.boundEventId === f.eventId),
      ),
    [refusalFrames],
  );

  const check = useCallback(async (fr: StoredFrame) => {
    setVerified((v) => ({ ...v, [fr.id]: { status: "error", detail: "checking…" } }));
    const result = await verifyFrame(fr);
    setVerified((v) => ({ ...v, [fr.id]: result }));
  }, []);

  const photographed = useMemo(
    () => failures.filter((f) => frameFor(f)).length,
    [failures, frameFor],
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (error) return <ErrorNote error={error} />;

  return (
    <div className="fail-page">
      <div className="fail-bar">
        <span className={`fail-live ${stream === "live" ? "on" : "off"}`}>
          <span className="fail-dot" />
          {stream === "live" ? "live" : stream === "connecting" ? "connecting" : "reconnecting"}
        </span>
        <span className="fail-tally">
          {failures.length} refused · {photographed} photographed
        </span>
      </div>

      <Card
        title="Evidence camera"
        hint="Fires only on a refusal — never on a timer, never on a granted unlock"
      >
        <div className="fail-cam">
          <video
            ref={previewRef}
            className={cameraOn ? "fail-preview" : "fail-preview off"}
            muted
            playsInline
          />
          <div className="fail-cam-side">
            {!identity ? (
              <>
                <div className="wit-note">
                  This browser is not enrolled as a signing device, so nothing it photographs
                  can be committed. Pairing generates a keypair here and registers only the
                  public half.
                </div>
                <button className="wit-btn" onClick={() => void pair()} disabled={pairing}>
                  {pairing ? "Pairing…" : "Pair this browser"}
                </button>
              </>
            ) : (
              <div className="wit-note">
                Enrolled as <code>{identity.deviceId.slice(0, 8)}</code>. The private key is in
                this browser's local storage and is not TPM-bound — a demonstration
                credential, as <code>adr/0003</code> records.
              </div>
            )}

            {cameraError && <div className="wit-note warn">{cameraError}</div>}

            {/* A capture that the ledger refused used to fail in silence, so
                the page showed "no photograph" for a reason it already knew.
                Whatever went wrong is said here, next to the control that
                fixes it. */}
            {lastError && (
              <div className="wit-note warn">
                {lastError.message}
                {/^This browser's signing key/.test(lastError.message) && identity && (
                  <>
                    {" "}
                    <button
                      className="wit-btn"
                      style={{ marginTop: 6 }}
                      onClick={() => {
                        forget();
                        void pair();
                      }}
                    >
                      Forget and pair again
                    </button>
                  </>
                )}
              </div>
            )}

            {busy && <div className="wit-note">{busy}…</div>}

            {cameraOn ? (
              <button className="wit-btn ghost" onClick={stopCamera}>
                Stop camera
              </button>
            ) : (
              <button className="wit-btn" onClick={() => void startCamera()}>
                Start camera
              </button>
            )}

            {!cameraOn && (
              <div className="wit-note warn">
                While this is off, refusals are still recorded — they simply arrive with no
                photograph, and the card says so.
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="note">
        Only refusals appear here — nothing that succeeded. The photograph is taken by{" "}
        <strong>this machine's camera</strong>: the station's ESP32 reads the finger and has
        no camera fitted, so the frame shows this terminal, not the exam hall.
      </div>

      {loading ? (
        <Card>
          <Empty>Reading the chain…</Empty>
        </Card>
      ) : failures.length === 0 ? (
        <Card>
          <Empty>
            No refused attempts in the last {BACKFILL} events. A refused unlock, or a finger
            the reader does not know, will appear here on its own.
          </Empty>
        </Card>
      ) : (
        <div className="fail-grid">
          {failures.map((f) => {
            const fr = frameFor(f);
            const v = fr ? verified[fr.id] : undefined;
            return (
              <article key={f.key} className="fail-card">
                <header className="fail-head">
                  <span className="fail-title">FAILED UNLOCK ATTEMPT</span>
                  {fresh.has(f.key) && <span className="fail-new">NEW</span>}
                </header>

                {fr ? (
                  <img className="fail-photo" src={urls[fr.id]} alt="" />
                ) : (
                  <div className="fail-photo empty">no photograph</div>
                )}

                <dl className="fail-rows">
                  <dt>Station</dt>
                  <dd>
                    <code>{f.stationId.slice(0, 8)}</code>
                    {f.centreCode && <span className="fail-dim"> · {f.centreCode}</span>}
                  </dd>

                  <dt>Reason</dt>
                  <dd className="fail-reason">{f.reasons.map(say).join(" · ")}</dd>

                  <dt>Time</dt>
                  <dd>{formatTime(f.occurredAt)}</dd>

                  <dt>{f.source === "station" ? "Event ID" : "Attempt ID"}</dt>
                  <dd>
                    <code>{(f.eventId ?? f.attemptId ?? "—").slice(0, 8)}</code>
                    {f.seq && <span className="fail-dim"> · seq {f.seq}</span>}
                  </dd>

                  <dt>Evidence</dt>
                  <dd>
                    {!fr ? (
                      <span className="fail-dim">none held on this machine</span>
                    ) : v?.status === "match" ? (
                      <span className="fail-ok">VERIFIED ✓ bytes match the committed digest</span>
                    ) : v?.status === "mismatch" ? (
                      <span className="fail-bad">MISMATCH — not the committed image</span>
                    ) : v?.status === "error" ? (
                      <span className="fail-dim">{v.detail}</span>
                    ) : (
                      <span className="fail-dim" title={fr.sha256}>
                        sha256 {fr.sha256.slice(0, 20)}… — not checked
                      </span>
                    )}
                  </dd>
                </dl>

                <footer className="fail-foot">
                  <span className="fail-badge">DENIED</span>
                  {fr && (
                    <span className="fail-actions">
                      <button className="wit-btn" onClick={() => void check(fr)}>
                        {v && v.status !== "error" ? "Re-check" : "Verify"}
                      </button>
                      <a className="wit-btn" href={urls[fr.id]} download={frameFileName(fr)}>
                        Download
                      </a>
                    </span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
