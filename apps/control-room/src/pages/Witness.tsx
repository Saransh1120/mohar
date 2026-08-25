import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AccessAttempt, type RawEvent } from "../lib/api";
import { useAsync, formatTime } from "../lib/hooks";
import { Card, Empty, ErrorNote } from "../components/ui";
import {
  captureFrame,
  loadIdentity,
  pairThisBrowser,
  forgetIdentity,
  nowTimestamp,
  signAndPost,
  type CentreIdentity,
} from "../lib/witness";
import {
  allFrames,
  clearFrames,
  deleteFrame,
  frameFileName,
  putFrame,
  storeAvailable,
  verifyFrame,
  type StoredFrame,
  type VerifyResult,
} from "../lib/frameStore";
import {
  setSoundEnabled,
  isSoundEnabled,
  unlockAudio,
  soundAssertion,
  soundTwoPerson,
  soundGranted,
  soundDenied,
  soundRefused,
  soundSilent,
} from "../lib/sound";
import { station, loadStationUrl, normalise } from "../lib/station";
import { useEvidence } from "../lib/evidence";

/**
 * ── The unlock ceremony, watched live ────────────────────────────────────────
 *
 * The station in the room reads fingerprints and signs `WITNESS_ASSERTED`. This
 * page watches the chain for those records, and for each new one photographs
 * whoever is in front of this machine's camera and commits the frame's hash as
 * `WITNESS_FRAME`.
 *
 * Two properties are deliberate and worth defending out loud:
 *
 *   • **The camera fires only on an assertion.** Never on a timer, never on
 *     motion, never on the operator's say-so. `docs/06` ruled out continuous
 *     surveillance and event-scoping is the resolution — a handful of frames
 *     per exam of two officials performing one duty, not hours of a corridor.
 *   • **The image never enters the ledger.** Only its SHA-256 is committed. The
 *     JPEG stays in this browser and is offered as a download. Losing it later
 *     does not break the chain; it only means the commitment can no longer be
 *     checked against anything.
 *
 * The page never decides anything. It shows what the chain says and what the
 * access engine returned, and where evidence is missing it says so.
 */

const POLL_MS = 2000;

interface Assertion {
  eventId: string;
  seq: string;
  stationId: string;
  sessionId: string;
  role: string;
  templateSlot: number;
  matchScore: number;
  occurredAt: string;
  frameOnStation: boolean;
}

interface CeremonyOutcome {
  sessionId: string;
  outcome: string;
  assertionCount: number;
  distinctSlots: boolean;
  windowSeconds: number;
  occurredAt: string;
}

/**
 * One thing the reader did, accepted or not.
 *
 * Rejections matter as much as matches here. A run of refusals at 08:40 is
 * either a worn hand that needs re-enrolling or somebody at the reader who
 * should not be, and both are invisible if only successes are shown.
 */
interface Read {
  id: string;
  at: string;
  accepted: boolean;
  detail: string;
  slot?: number;
  score?: number;
  stationId?: string;
}


/**
 * Frames are no longer held in component state — see `lib/frameStore`. The
 * record shape lives there because it is what gets written to disk, and a
 * second definition here would drift from it the first time either changed.
 */

export default function Witness() {
  const [identity, setIdentity] = useState<CentreIdentity | null>(() => loadIdentity());
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * The camera is the provider's, not this page's.
   *
   * Two owners meant two `getUserMedia` streams and, worse, two capture paths
   * that each photographed the same refusal — one from here and one from the
   * provider's watch on refused attempts. Sharing the stream leaves one
   * de-duplication set and therefore one photograph per refusal, which is what
   * the record is supposed to mean.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const {
    cameraOn,
    cameraError,
    startCamera,
    stopCamera,
    attachPreview,
    capture: captureRefusal,
  } = useEvidence();

  useEffect(() => {
    attachPreview(videoRef.current);
    return () => attachPreview(null);
  }, [attachPreview, cameraOn]);

  const [assertions, setAssertions] = useState<Assertion[]>([]);
  const [outcomes, setOutcomes] = useState<CeremonyOutcome[]>([]);
  const [gallery, setGallery] = useState<StoredFrame[]>([]);
  /** Object URLs for the stored blobs, rebuilt whenever the gallery changes. */
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [storeOk, setStoreOk] = useState<boolean | null>(null);
  const [verified, setVerified] = useState<Record<string, VerifyResult>>({});
  const [committedFor, setCommittedFor] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [reads, setReads] = useState<Read[]>([]);
  const [sealSerial, setSealSerial] = useState("");
  const [custodyKey, setCustodyKey] = useState("");
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracyM: number } | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [sound, setSound] = useState(isSoundEnabled());

  /**
   * A completed ceremony that has not yet been put to the access engine.
   *
   * Asking before the ceremony is not merely early, it asks the wrong question:
   * with no assertion to read, the page has no station to make the request as
   * and no person to name, so the engine evaluates the browser's binding and
   * nobody's roster membership. The three refusals that produces are correct
   * answers to a question the operator did not mean to ask.
   */
  const [awaitingDecision, setAwaitingDecision] = useState<string | null>(null);

  // The last decision we have already announced. Without this the poll would
  // replay the same refusal every four seconds, which trains the room to ignore
  // the sound entirely.
  const spokenAttemptRef = useRef<string>("");

  const cursorRef = useRef<string>("0");
  const seenRef = useRef<Set<string>>(new Set());

  /**
   * The chain tip as it stood when this page opened.
   *
   * The page backfills recent ceremonies so the panel is not empty, and every
   * one of those is an outcome that already happened. Announcing them would
   * play a dozen refusals at load and teach the room that the sound means
   * nothing. Anything at or below this sequence is history and stays silent;
   * only what arrives afterwards is spoken.
   */
  const historyTipRef = useRef<number>(Number.POSITIVE_INFINITY);

  const { data: pkgs } = useAsync(() => api.packages(), []);

  /**
   * The station knows which package it is witnessing, so the operator should not
   * have to pick it off a list of fifteen under stage lights. A wrong pick there
   * produces a refusal that looks like the system failing when it was the
   * operator who missed — and the refusal is real and permanent in the chain.
   *
   * Chosen once, and never re-imposed: if the operator deliberately selects a
   * different package the page leaves that alone.
   */
  const { data: stationStatus } = useAsync(
    () => {
      const base = normalise(loadStationUrl());
      return base ? station.status(base).catch(() => null) : Promise.resolve(null);
    },
    [],
    { pollMs: 10_000 },
  );
  const autoSelected = useRef(false);
  const { data: enrolments } = useAsync(() => api.fingerprints(), [], { pollMs: 20_000 });
  const [packageId, setPackageId] = useState<string>("");

  /**
   * The envelope needs an exam id, and until now the only thing that supplied
   * one was an incoming assertion. That is fine for the ceremony path and wrong
   * for every other: pressing "request unlock" before any finger has been read
   * built an event with an empty `examId`, which the ledger rejects — so the
   * one refusal most worth a photograph produced none.
   */
  useEffect(() => {
    const pkg = pkgs?.packages?.find((p) => p.id === packageId);
    if (!pkg) return;
    examIdRef.current = pkg.examId;
    centreIdRef.current = pkg.centreId;
  }, [packageId, pkgs]);

  useEffect(() => {
    if (autoSelected.current) return;
    const wanted = stationStatus?.packageId;
    if (!wanted || !pkgs?.packages?.some((p) => p.id === wanted)) return;
    autoSelected.current = true;
    setPackageId(wanted);
  }, [stationStatus, pkgs]);

  const { data: attemptData, refresh: refreshAttempts } = useAsync(
    () => (packageId ? api.attempts({ packageId, limit: 5 }) : Promise.resolve({ attempts: [] })),
    [packageId],
    { pollMs: 4000 },
  );

  // ── camera ────────────────────────────────────────────────────────────────


  // ── the stored frames ─────────────────────────────────────────────────────

  /**
   * Load what previous sessions photographed.
   *
   * Before this the images were component state, so a refresh in the middle of
   * an exam threw away every frame taken that morning and left the chain full
   * of digests with nothing on the machine to check them against.
   */
  useEffect(() => {
    void storeAvailable().then(setStoreOk);
    void allFrames().then(setGallery);
  }, []);

  /**
   * Object URLs, not data URLs.
   *
   * A 1280x720 JPEG as base64 is roughly a third larger again and has to be
   * held as a string for as long as the thumbnail is on screen; forty of those
   * is real memory on a machine that is also driving a camera. The URLs are
   * revoked when the gallery changes, because a leaked blob URL pins the whole
   * image for the lifetime of the document.
   */
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of gallery) next[f.id] = URL.createObjectURL(f.blob);
    setUrls(next);
    return () => {
      for (const u of Object.values(next)) URL.revokeObjectURL(u);
    };
  }, [gallery]);

  /** Re-hash one stored frame against the digest the ledger accepted. */
  const checkFrame = useCallback(async (f: StoredFrame) => {
    const result = await verifyFrame(f);
    setVerified((v) => ({ ...v, [f.id]: result }));
  }, []);

  const forgetFrame = useCallback(async (f: StoredFrame) => {
    await deleteFrame(f.id);
    setGallery((g) => g.filter((x) => x.id !== f.id));
  }, []);

  /**
   * Delete every image on this machine.
   *
   * Offered deliberately. These are photographs of identifiable people taken at
   * a school, and the operator needs a way to dispose of them that is not
   * "find the browser profile directory". The commitments stay in the chain, so
   * what is lost is the ability to check them, not the record that they were
   * made.
   */
  const forgetAll = useCallback(async () => {
    await clearFrames();
    setGallery([]);
    setVerified({});
  }, []);

  // ── watch the chain ───────────────────────────────────────────────────────

  /**
   * Commit a photograph for one assertion.
   *
   * Capture first, then sign, then post — and record locally that this
   * assertion has been dealt with only after the ledger accepts it, so a failed
   * post is retried on the next poll rather than silently skipped.
   */
  const commitFrameFor = useCallback(
    async (a: Assertion, id: CentreIdentity) => {
      if (!videoRef.current || !cameraOn) return;
      setBusy(`photographing the ${a.role}`);
      try {
        const shot = await captureFrame(videoRef.current);
        const body = {
          v: 1 as const,
          id: crypto.randomUUID(),
          examId: examIdRef.current,
          ...(centreIdRef.current ? { centreId: centreIdRef.current } : {}),
          ...(packageIdRef.current ? { packageId: packageIdRef.current } : {}),
          kind: "WITNESS_FRAME" as const,
          occurredAt: nowTimestamp(),
          actorDeviceId: id.deviceId,
          payload: {
            sessionId: a.sessionId,
            assertionEventId: a.eventId,
            frameSha256: shot.sha256,
            frameBytes: shot.blob.size,
            width: shot.width,
            height: shot.height,
          },
        };
        const out = await signAndPost(body as never, id);
        if (out.status === "rejected") {
          setError(new Error(`ledger refused the frame: ${out.code}`));
          return;
        }
        const stored: StoredFrame = {
          id: body.id,
          kind: "assertion",
          boundEventId: a.eventId,
          sessionId: a.sessionId,
          packageId: packageIdRef.current || null,
          sha256: shot.sha256,
          seq: out.seq,
          capturedAt: body.occurredAt,
          width: shot.width,
          height: shot.height,
          bytes: shot.blob.size,
          blob: shot.blob,
          reasons: [],
        };
        await putFrame(stored);
        setGallery((g) => [stored, ...g]);
        setCommittedFor((s) => new Set(s).add(a.eventId));
      } catch (err) {
        setError(err as Error);
      } finally {
        setBusy(null);
      }
    },
    [cameraOn],
  );


  // Refs so the poll loop reads current values without re-subscribing.
  const examIdRef = useRef<string>("");
  const centreIdRef = useRef<string>("");
  const packageIdRef = useRef<string>("");
  packageIdRef.current = packageId;

  useEffect(() => {
    let stopped = false;

    // Read the tip before the first poll, so the backfill has a boundary to be
    // measured against rather than a guess.
    void api
      .health()
      .then((h) => {
        if (!stopped) historyTipRef.current = Number(h.chainTip?.seq ?? 0);
      })
      .catch(() => {
        // Unknown tip means we cannot tell history from now, and a page that
        // guesses would announce old refusals as if they had just happened.
        if (!stopped) historyTipRef.current = Number.POSITIVE_INFINITY;
      });

    const tick = async () => {
      try {
        const { events } = await api.rawEvents(cursorRef.current, 200);
        if (stopped || events.length === 0) return;
        cursorRef.current = events[events.length - 1]!.seq;

        const newAssertions: Assertion[] = [];
        for (const e of events as RawEvent[]) {
          if (seenRef.current.has(e.id)) continue;
          seenRef.current.add(e.id);
          const p = e.body.payload;
          const live = Number(e.seq) > historyTipRef.current;

          if (e.kind === "EXCEPTION_RAISED") {
            // The station's own refusals: a finger that matched nothing, one
            // too weak to count, or the same finger presented twice.
            const code = String(p["code"] ?? "");
            if (code.startsWith("biometric_")) {
              if (live) soundRefused();
              setReads((r) =>
                [
                  {
                    id: e.body.id,
                    at: e.body.occurredAt,
                    accepted: false,
                    detail:
                      code === "biometric_no_match"
                        ? "no enrolled template matched"
                        : "match too weak to count",
                  },
                  ...r,
                ].slice(0, 12),
              );
            }
            continue;
          }

          if (e.kind === "MONITOR_SILENT") {
            if (live) soundSilent();
            continue;
          }

          if (e.kind === "WITNESS_ASSERTED") {
            examIdRef.current = e.body.examId;
            centreIdRef.current = e.body.centreId ?? "";
            const a: Assertion = {
              eventId: e.body.id,
              seq: e.seq,
              stationId: e.body.actorDeviceId,
              sessionId: String(p["sessionId"]),
              role: String(p["role"]),
              templateSlot: Number(p["templateSlot"]),
              matchScore: Number(p["matchScore"]),
              occurredAt: e.body.occurredAt,
              frameOnStation: Number(p["frameBytes"] ?? 0) > 0,
            };
            newAssertions.push(a);
            setReads((r) =>
              [
                {
                  id: e.body.id,
                  at: e.body.occurredAt,
                  accepted: true,
                  detail: `matched as the ${a.role}`,
                  slot: a.templateSlot,
                  score: a.matchScore,
                  stationId: a.stationId,
                },
                ...r,
              ].slice(0, 12),
            );
            if (live) soundAssertion();
          } else if (e.kind === "WITNESS_CEREMONY") {
            const outcome = String(p["outcome"]);
            if (live) {
              if (outcome === "two_person_confirmed") {
                soundTwoPerson();
                // The ceremony is the trigger. Making the operator press a
                // button afterwards is what let the wrong question be asked.
                setAwaitingDecision(String(p["sessionId"]));
              } else {
                soundRefused();
              }
            }
            setOutcomes((o) => [
              {
                sessionId: String(p["sessionId"]),
                outcome: String(p["outcome"]),
                assertionCount: Number(p["assertionCount"]),
                distinctSlots: Boolean(p["distinctSlots"]),
                windowSeconds: Number(p["windowSeconds"]),
                occurredAt: e.body.occurredAt,
              },
              ...o,
            ]);
          } else if (e.kind === "WITNESS_FRAME") {
            setCommittedFor((s) => new Set(s).add(String(p["assertionEventId"])));
          }
        }

        if (newAssertions.length > 0) {
          setAssertions((prev) => [...newAssertions.reverse(), ...prev].slice(0, 40));
          const id = identity;
          if (id) {
            for (const a of newAssertions) {
              if (a.frameOnStation) continue; // the station photographed it itself
              await commitFrameFor(a, id);
            }
          }
        }
      } catch (err) {
        if (!stopped) setError(err as Error);
      }
    };

    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [identity, commitFrameFor]);

  // ── grouping ──────────────────────────────────────────────────────────────

  const sessions = useMemo(() => {
    const map = new Map<string, { assertions: Assertion[]; outcome?: CeremonyOutcome }>();
    for (const a of assertions) {
      const g = map.get(a.sessionId) ?? { assertions: [] };
      g.assertions.push(a);
      map.set(a.sessionId, g);
    }
    for (const o of outcomes) {
      const g = map.get(o.sessionId) ?? { assertions: [] };
      g.outcome = o;
      map.set(o.sessionId, g);
    }
    return [...map.entries()].slice(0, 8);
  }, [assertions, outcomes]);

  /**
   * Slot to person, as at the time of the assertion.
   *
   * Not as at now: a slot retired and reassigned last week must not rewrite who
   * a record from last month refers to. An unmapped slot says so rather than
   * showing a blank — a template nobody registered is a finding, because it
   * means a finger was enrolled outside the process.
   */
  const nameFor = useCallback(
    (a: Assertion): string => {
      const at = Date.parse(a.occurredAt);
      const hit = (enrolments?.enrolments ?? [])
        .filter(
          (e) =>
            e.deviceId === a.stationId &&
            e.templateSlot === a.templateSlot &&
            Date.parse(e.enrolledAt) <= at &&
            (!e.revokedAt || Date.parse(e.revokedAt) > at),
        )
        .sort((x, y) => Date.parse(y.enrolledAt) - Date.parse(x.enrolledAt))[0];
      return hit ? hit.personName : "";
    },
    [enrolments],
  );

  /**
   * Put a finished ceremony to the engine as soon as its assertions have
   * arrived, and once only.
   *
   * The outcome event and the assertions it refers to can land in the same
   * poll, so this waits for the session to actually be in view rather than
   * firing on the outcome alone and asking with an empty witness list.
   */
  useEffect(() => {
    if (!awaitingDecision) return;
    const session = sessions.find(([sid]) => sid === awaitingDecision);
    if (!session || session[1].assertions.length < 2) return;
    setAwaitingDecision(null);
    void requestUnlock(awaitingDecision);
    // requestUnlock is stable enough for this: it reads current state through
    // refs and setters, and adding it here would re-fire on every keystroke in
    // the seal and key fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingDecision, sessions]);

  const personIdFor = useCallback(
    (a: Assertion): string | undefined => {
      const at = Date.parse(a.occurredAt);
      return (enrolments?.enrolments ?? []).find(
        (e) =>
          e.deviceId === a.stationId &&
          e.templateSlot === a.templateSlot &&
          Date.parse(e.enrolledAt) <= at &&
          (!e.revokedAt || Date.parse(e.revokedAt) > at),
      )?.personId;
    },
    [enrolments],
  );

  const latestAttempt: AccessAttempt | undefined = attemptData?.attempts?.[0];

  // Said once, when it first appears. A decision is an event, not a state to be
  // re-announced on every poll.
  useEffect(() => {
    if (!latestAttempt) return;
    if (spokenAttemptRef.current === latestAttempt.id) return;
    const first = spokenAttemptRef.current === "";
    spokenAttemptRef.current = latestAttempt.id;
    // Do not announce whatever happened to be the newest attempt when the page
    // loaded — that one is history, and history should not sound like now.
    if (first) return;
    if (latestAttempt.outcome === "granted") {
      soundGranted();
      return;
    }
    soundDenied();

    // The photograph is not taken here. The provider watches refused attempts
    // for the whole app, so a refusal is photographed whichever page is open —
    // and photographed once, because one de-duplication set decides.
  }, [latestAttempt]);

  // ── pairing ───────────────────────────────────────────────────────────────

  const pair = async () => {
    setPairing(true);
    setError(null);
    try {
      setIdentity(await pairThisBrowser());
    } catch (err) {
      setError(err as Error);
    } finally {
      setPairing(false);
    }
  };

  /**
   * Ask the browser where it is.
   *
   * The geofence check exists to prove the requesting device is at the centre.
   * A demo that skipped it or widened the radius would be demonstrating nothing,
   * so the real fix is used — and if it is outside the centre's radius the
   * engine refuses, correctly.
   */
  const takeFix = () => {
    setFixError(null);
    if (!navigator.geolocation) {
      setFixError("This browser has no geolocation.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setFix({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          // Rounded, because the engine compares it against a radius in metres
          // and sub-metre precision here is false confidence.
          accuracyM: Math.round(pos.coords.accuracy),
        }),
      (err) =>
        setFixError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was refused. Allow it and press Locate again."
            : "Could not get a position fix.",
        ),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  /**
   * The request is made on behalf of the station, not the browser.
   *
   * The station is the device in the room, bound to the centre at enrolment and
   * the one that read the fingerprints. The browser holds a camera. Sending the
   * browser's id would ask the engine to check the wrong device's binding, and
   * it would pass or fail for reasons that have nothing to do with the ceremony.
   */
  const requestUnlock = async (sessionId?: string) => {
    if (!packageId || !identity) return;
    setBusy("asking the access engine");
    try {
      const session = sessionId
        ? sessions.find(([sid]) => sid === sessionId)
        : sessions[0];
      const witnesses = session?.[1].assertions ?? [];
      const station = witnesses[0]?.stationId ?? identity.deviceId;

      // Who to name as the actor comes from the biometric, not from a dropdown:
      // the superintendent's slot resolves to a person through the enrolment
      // register. An unregistered slot names nobody, and the engine refuses for
      // `person_not_on_roster` — which is the correct answer.
      const primary = witnesses.find((w) => w.role === "superintendent");
      const personId = primary ? personIdFor(primary) : undefined;

      const decision = await api.requestAccess({
        packageId,
        stage: "unlock",
        deviceId: station,
        ...(personId ? { personId } : {}),
        ...(custodyKey.trim() ? { presentedKey: custodyKey.trim() } : {}),
        ...(sealSerial.trim() ? { sealSerialRead: sealSerial.trim() } : {}),
        ...(fix ? { geo: fix } : {}),
      });

      /**
       * Photograph the refusal on the response rather than waiting to be told.
       *
       * The provider's watch would find this attempt within a few seconds
       * anyway, but this path knows the refusal is *live* without inferring it:
       * the request was made by this page, one moment ago, at this terminal,
       * which is exactly the claim the photograph supports. Calling the
       * provider rather than capturing here keeps both routes behind the same
       * key, so the watch finds it already done and does not take a second.
       */
      if (decision.outcome === "denied") {
        await captureRefusal({
          key: `attempt:${decision.attemptId}`,
          attemptId: decision.attemptId,
          examId: examIdRef.current,
          ...(centreIdRef.current ? { centreId: centreIdRef.current } : {}),
          ...(packageId ? { packageId } : {}),
          sessionId: decision.sessionId,
          reasons: decision.denyReasons,
        });
      }
      await refreshAttempts();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="witness">
      {error && <ErrorNote error={error} />}

      <Card
        title="This browser as a signing device"
        hint="The photograph needs an enrolled device behind it, and nothing else on this machine can attest to what its camera saw"
      >
        {identity ? (
          <div className="wit-identity">
            <div>
              <div className="wit-label">enrolled as</div>
              <code>{identity.deviceId}</code>
              <div className="wit-note">
                The private key is in this browser's local storage. It is not bound to the
                TPM and the enrolment was not attested — <code>docs/02</code> specifies both
                and <code>adr/0003</code> records that neither exists yet. Treat this as a
                demonstration credential.
              </div>
            </div>
            <button
              className="wit-btn ghost"
              onClick={() => {
                forgetIdentity();
                setIdentity(null);
              }}
            >
              Forget this key
            </button>
          </div>
        ) : (
          <div className="wit-identity">
            <div className="wit-note">
              Not enrolled. Pairing generates an Ed25519 keypair here and registers only the
              public half, so the signing key never crosses the network.
            </div>
            <button
              className="wit-btn"
              onClick={() => {
                unlockAudio();
                void pair();
              }}
              disabled={pairing}
            >
              {pairing ? "Pairing…" : "Pair this browser"}
            </button>
          </div>
        )}
      </Card>

      <div className="wit-grid">
        <Card
          title="Camera"
          hint="Fires only when the station reports a fingerprint match — never on a timer"
        >
          <div className="wit-video-wrap">
            <video ref={videoRef} className="wit-video" playsInline muted />
            {!cameraOn && <div className="wit-video-off">camera off</div>}
            {busy && <div className="wit-busy">{busy}…</div>}
          </div>
          {cameraError && <div className="wit-error">{cameraError}</div>}
          <div className="wit-actions">
            <button
              className={sound ? "wit-btn" : "wit-btn ghost"}
              onClick={() => {
                const next = !sound;
                setSound(next);
                setSoundEnabled(next);
              }}
              title="Outcomes are announced aloud — granted rises, refused is three flat low tones"
            >
              {sound ? "Sound on" : "Sound off"}
            </button>
            {cameraOn ? (
              <button className="wit-btn ghost" onClick={stopCamera}>
                Stop camera
              </button>
            ) : (
              <button
                className="wit-btn"
                onClick={() => {
                  // A click is the gesture browsers demand before audio may
                  // start. Taking it here means the first outcome of the
                  // ceremony is audible, rather than the second onwards.
                  unlockAudio();
                  void startCamera();
                }}
              >
                Start camera
              </button>
            )}
          </div>
        </Card>

        <Card
          title="Package"
          hint="Which sealed bundle this ceremony is opening"
        >
          <select
            className="wit-select"
            value={packageId}
            onChange={(e) => {
              autoSelected.current = true;
              setPackageId(e.target.value);
            }}
          >
            <option value="">— choose a package —</option>
            {(pkgs?.packages ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.centreCode ?? p.id.slice(0, 8)} · {p.sealSerial ?? "no seal"}
              </option>
            ))}
          </select>

          {sessions.length === 0 && (
            <div className="wit-note warn">
              No ceremony yet. The decision is asked automatically once two officials
              have authenticated — asking now would put the question as this browser
              rather than as the station in the room, and be refused for
              <code> device_not_bound_to_centre</code> and <code>person_not_on_roster</code>.
            </div>
          )}
          {awaitingDecision && (
            <div className="wit-note">Ceremony complete — asking the access engine…</div>
          )}

          {stationStatus?.packageId && packageId === stationStatus.packageId && (
            <div className="wit-note">
              Selected from the station's own configuration — this is the package the
              reader in the room is set to witness.
            </div>
          )}
          {stationStatus?.packageId && packageId && packageId !== stationStatus.packageId && (
            <div className="wit-note warn">
              The station is configured for a different package. The engine will refuse
              this one for <code>device_not_bound_to_centre</code>, and it will be right to.
            </div>
          )}

          <div className="unlock-inputs">
            <label>
              <span>Seal serial, as read off the seal</span>
              <input
                className="wit-select"
                placeholder="type the serial printed on the seal"
                value={sealSerial}
                onChange={(e) => setSealSerial(e.target.value)}
              />
            </label>
            <label>
              <span>Custody key for this stage</span>
              <input
                className="wit-select"
                placeholder="paste the custody key for this stage"
                value={custodyKey}
                onChange={(e) => setCustodyKey(e.target.value)}
              />
            </label>
          </div>

          <div className="wit-actions">
            <button className="wit-btn ghost" onClick={takeFix}>
              {fix ? "Re-locate" : "Locate"}
            </button>
            <button
              className="wit-btn"
              onClick={() => void requestUnlock()}
              disabled={!packageId || !identity || !!busy}
            >
              Request unlock decision
            </button>
          </div>

          {fix && (
            <div className="wit-note">
              Fix: <code>{fix.lat.toFixed(6)}, {fix.lon.toFixed(6)}</code> ±{fix.accuracyM} m.
              These are the coordinates to register the demo centre at.
            </div>
          )}
          {fixError && <div className="wit-error">{fixError}</div>}
          {!fix && !fixError && (
            <div className="wit-note">
              No position fix. The engine refuses for <code>geo_missing</code> until you
              locate — the geofence check exists to prove this device is at the centre.
            </div>
          )}

          {latestAttempt ? (
            <div className={`wit-decision ${latestAttempt.outcome}`}>
              <div className="wit-decision-head">
                {latestAttempt.outcome === "granted" ? "Access granted" : "Access refused"}
              </div>
              <div className="wit-note">{formatTime(latestAttempt.decidedAt)}</div>
              {latestAttempt.denyReasons.length > 0 && (
                <ul className="wit-reasons">
                  {latestAttempt.denyReasons.map((r) => (
                    <li key={r}>{r.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              )}
              <div className="wit-note">
                {latestAttempt.checksPassed.length} checks passed. Every attempt is written
                to the chain before the answer is returned, refusals included.
              </div>
            </div>
          ) : (
            <Empty>No access attempt recorded for this package yet.</Empty>
          )}
        </Card>
      </div>

      <Card
        title="Fingerprint reader"
        hint="Every read the station produced, accepted or refused"
      >
        {reads.length === 0 ? (
          <Empty>
            No finger has been presented yet. Touch the reader — a template that is
            not enrolled is refused, and the refusal is recorded rather than
            discarded.
          </Empty>
        ) : (
          <div className="fp-reads">
            {reads.map((r) => (
              <div key={r.id} className={`fp-read ${r.accepted ? "ok" : "no"}`}>
                <span className="fp-dot" />
                <div className="fp-body">
                  <div className="fp-head">
                    {r.accepted ? "Accepted" : "Refused"}
                    {r.slot !== undefined && (
                      <span className="fp-meta">
                        slot {r.slot} · score {r.score}
                      </span>
                    )}
                  </div>
                  <div className="wit-note">{r.detail}</div>
                  <div className="wit-note">{formatTime(r.at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="wit-note">
          The reader gives up a slot number and a score and nothing else. No image, no
          template, no minutiae leave the module — which is why a breach of this database
          cannot leak a biometric.
        </div>
      </Card>

      <Card
        title="Ceremonies"
        hint="Live from the chain. Each assertion is a fingerprint the station matched; each frame is a photograph this machine committed"
      >
        {sessions.length === 0 ? (
          <Empty>
            Nothing yet. Present a finger at the station — the first match opens a session.
          </Empty>
        ) : (
          <div className="wit-sessions">
            {sessions.map(([sid, g]) => (
              <div key={sid} className="wit-session">
                <div className="wit-session-head">
                  <code>{sid.slice(0, 8)}</code>
                  <span className={`wit-pill ${g.outcome?.outcome ?? "open"}`}>
                    {g.outcome
                      ? g.outcome.outcome.replace(/_/g, " ")
                      : `${g.assertions.length} of 2 — window open`}
                  </span>
                </div>

                {g.outcome && !g.outcome.distinctSlots && g.outcome.outcome !== "window_expired" && (
                  <div className="wit-note warn">
                    Not two distinct templates. One person presenting twice is not a
                    two-person act.
                  </div>
                )}

                <div className="wit-assertions">
                  {g.assertions.map((a) => {
                    const frame = gallery.find((f) => f.boundEventId === a.eventId);
                    const committed = frame || committedFor.has(a.eventId);
                    return (
                      <div key={a.eventId} className="wit-assertion">
                        {frame ? (
                          <img className="wit-thumb" src={urls[frame.id]} alt="" />
                        ) : (
                          <div className="wit-thumb empty">
                            {committed ? "committed" : "no frame"}
                          </div>
                        )}
                        <div>
                          <div className="wit-role">
                            {nameFor(a) || <span className="wit-unmapped">slot not registered</span>}
                          </div>
                          <div className="wit-note">
                            {a.role} · template slot {a.templateSlot}, score {a.matchScore}
                          </div>
                          {!nameFor(a) && (
                            <div className="wit-note warn">
                              This template is not mapped to anyone. Register it on the
                              Slots page — the access engine reports it as unmapped.
                            </div>
                          )}
                          <div className="wit-note">{formatTime(a.occurredAt)}</div>
                          {frame && (
                            <div className="wit-hash" title={frame.sha256}>
                              sha256 {frame.sha256.slice(0, 24)}…
                            </div>
                          )}
                          {!committed && (
                            <div className="wit-note warn">
                              no photograph committed for this assertion
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Frames held on this machine"
        hint="The images behind the digests in the chain. Kept in this browser, not in the ledger"
        actions={
          gallery.length > 0 ? (
            <button className="wit-btn" onClick={() => void forgetAll()}>
              Delete all {gallery.length}
            </button>
          ) : undefined
        }
      >
        {storeOk === false && (
          <div className="wit-note warn">
            This browser has no usable IndexedDB, so frames are not being kept. Photographs
            are still captured and their hashes still committed — there is simply nothing
            here to check them against afterwards.
          </div>
        )}

        {gallery.length === 0 ? (
          <Empty>
            No frames stored yet. One is taken for each fingerprint assertion, and one for
            each refused attempt.
          </Empty>
        ) : (
          <div className="frm-grid">
            {gallery.map((f) => {
              const v = verified[f.id];
              return (
                <figure key={f.id} className="frm-card">
                  <img className="frm-img" src={urls[f.id]} alt="" />
                  <figcaption>
                    <div className="frm-head">
                      <span className={`wit-pill ${f.kind}`}>
                        {f.kind === "refusal" ? "refused attempt" : "assertion"}
                      </span>
                      <span className="wit-note">{formatTime(f.capturedAt)}</span>
                    </div>

                    {f.reasons.length > 0 && (
                      <div className="wit-note">
                        engine refused: {f.reasons.join(", ").replace(/_/g, " ")}
                      </div>
                    )}

                    <div className="wit-hash" title={f.sha256}>
                      sha256 {f.sha256.slice(0, 24)}&#8230;
                    </div>
                    <div className="wit-note">
                      chain seq {f.seq} &middot; {f.width}&times;{f.height} &middot;{" "}
                      {Math.round(f.bytes / 1024)} KB
                    </div>

                    {v && (
                      <div className={`wit-note ${v.status === "match" ? "" : "warn"}`}>
                        {v.status === "match"
                          ? "Re-hashed: these bytes are the ones the ledger accepted."
                          : v.status === "mismatch"
                            ? `Re-hashed to ${v.actual.slice(0, 16)}… — this is NOT the committed image.`
                            : `Could not re-hash: ${v.detail}`}
                      </div>
                    )}

                    <div className="frm-actions">
                      <button className="wit-btn" onClick={() => void checkFrame(f)}>
                        {v ? "Re-check" : "Verify hash"}
                      </button>
                      <a className="wit-btn" href={urls[f.id]} download={frameFileName(f)}>
                        Download
                      </a>
                      <button className="wit-btn" onClick={() => void forgetFrame(f)}>
                        Delete
                      </button>
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="What this page does not claim"
        hint="Stated here because it belongs next to the evidence, not in a footnote"
      >
        <ul className="wit-limits">
          <li>
            An optical fingerprint reader is spoofable with a lifted print. These records
            establish that a body was present, not that the right body was.
          </li>
          <li>
            The finger and the photograph are witnessed by two different devices. A
            compromised centre PC could pair a genuine match with a substituted frame — what
            it cannot do is arrange that afterwards, because both halves are committed at the
            time.
          </li>
          <li>
            Only the hash of each frame is in the chain. The images are kept in this
            browser's own storage, on this machine only — clearing site data, or opening
            the page on another computer, leaves the commitments with nothing to check
            them against.
          </li>
          <li>
            The image store is not tamper-evident. Anyone with this profile can delete a
            frame. They cannot swap one, because a substitute fails the re-hash — but a
            missing frame means "cannot be checked", not "nothing happened".
          </li>
        </ul>
      </Card>
    </div>
  );
}
