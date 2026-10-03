import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Person } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { captureFrame, nowTimestamp, signAndPost, type CentreIdentity } from "../lib/witness";
import { putFrame, type StoredFrame } from "../lib/frameStore";
import {
  MATCH_DISTANCE,
  NEAR_MISS_DISTANCE,
  SAMPLES_PER_ENROLMENT,
  forgetEnrolments,
  loadEnrolments,
  loadModels,
  matchFace,
  readFace,
  saveEnrolments,
  scoreFromDistance,
  type FaceEnrolment,
} from "../lib/face";
import { Card } from "./ui";

/**
 * ── The face station ─────────────────────────────────────────────────────────
 *
 * The witness station in `docs/06` is an ESP32 with an R307 fingerprint reader.
 * Where one has not been fitted, this panel makes the centre PC's camera the
 * reader instead: it enrols two officials against two slots, watches for their
 * faces, and signs the same `WITNESS_ASSERTED` the fingerprint station signs.
 *
 * Everything downstream is unchanged and unassisted. The panel never decides
 * that an unlock is allowed — it writes what the camera saw into the chain and
 * the access engine rules on it, including the ways it can rule against:
 *
 *   • one person presenting twice closes the window as `same_finger_twice`,
 *     because the second assertion carries the same slot;
 *   • nobody recognised closes it as `window_expired`;
 *   • a slot never registered against a person resolves to nobody, and the
 *     engine refuses for `person_not_on_roster`.
 *
 * None of those outcomes are produced here. They are what the engine returns
 * when the panel reports honestly what happened in front of the camera.
 *
 * The weaknesses of matching a face rather than a finger — one device instead
 * of two, no liveness test, descriptors sitting in `localStorage` — are set out
 * at the top of `lib/face.ts` and in `docs/17`. The panel repeats the short
 * version on screen, because an operator should not have to read the source to
 * learn that a photograph held up to the lens may pass.
 */

/** How long a ceremony window stays open. The R307 station uses the same 120 s. */
const WINDOW_SECONDS = 120;

/** Between scans. Detection takes 100–300 ms on a laptop; this leaves headroom. */
const SCAN_MS = 900;

/**
 * Consecutive scans that see a face but recognise nobody before the station
 * records the fact. One bad frame is a person turning their head; six in a row,
 * roughly five seconds, is somebody at the camera who is not enrolled — and
 * that belongs in the chain as much as a match does.
 */
const UNKNOWN_SCANS_BEFORE_EXCEPTION = 6;

interface SessionState {
  id: string;
  startedAt: number;
  /** Slot → the assertion that recorded it. Distinctness is read off this. */
  asserted: Map<number, string>;
  /** Assertions posted, including a slot presented a second time. */
  count: number;
  /** A slot that matched again after it had already asserted. */
  repeats: number;
  closed: boolean;
  unknownStreak: number;
  exceptionPosted: boolean;
}

interface LogLine {
  at: string;
  text: string;
}

export function FaceStationPanel({
  getVideo,
  cameraOn,
  identity,
  getContext,
  onError,
}: {
  getVideo: () => HTMLVideoElement | null;
  cameraOn: boolean;
  identity: CentreIdentity | null;
  getContext: () => { examId: string; centreId: string; packageId: string };
  onError: (err: Error) => void;
}) {
  const [enrolments, setEnrolments] = useState<FaceEnrolment[]>(() => loadEnrolments());
  const [modelState, setModelState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [modelError, setModelError] = useState<string | null>(null);

  const { data: personData } = useAsync(() => api.persons(), []);
  const persons: Person[] = personData?.persons ?? [];

  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<"superintendent" | "observer">("superintendent");
  const [samples, setSamples] = useState<number[][]>([]);
  const [enrolNote, setEnrolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [live, setLive] = useState<string>("");
  const [remaining, setRemaining] = useState(WINDOW_SECONDS);

  const say = useCallback((text: string) => {
    setLog((l) => [{ at: new Date().toLocaleTimeString(), text }, ...l].slice(0, 14));
  }, []);

  // ── models ────────────────────────────────────────────────────────────────

  const ensureModels = useCallback(async () => {
    if (modelState === "ready" || modelState === "loading") return;
    setModelState("loading");
    setModelError(null);
    try {
      await loadModels();
      setModelState("ready");
    } catch (err) {
      setModelState("failed");
      setModelError((err as Error).message);
    }
  }, [modelState]);

  // ── enrolment ─────────────────────────────────────────────────────────────

  /**
   * Take one sample of whoever is in front of the camera.
   *
   * Samples are descriptors, not photographs: the image is discarded as soon as
   * the 128 floats are out of it. Three are taken because one is a single head
   * angle under one light, and a station that refuses its own superintendent at
   * the ceremony is worse than useless — the operator works around it.
   */
  const takeSample = useCallback(async () => {
    const video = getVideo();
    if (!video || !cameraOn) {
      setEnrolNote("Start the camera first.");
      return;
    }
    setBusy("reading the face");
    try {
      await ensureModels();
      const reading = await readFace(video);
      if (!reading) {
        setEnrolNote("No face in the frame. Face the camera and try again.");
        return;
      }
      setSamples((s) => [...s, reading.descriptor]);
      setEnrolNote(
        `Sample ${samples.length + 1} of ${SAMPLES_PER_ENROLMENT} taken ` +
          `(detector confidence ${reading.detectionScore.toFixed(2)}). ` +
          "Change your angle slightly before the next one.",
      );
    } catch (err) {
      onError(err as Error);
    } finally {
      setBusy(null);
    }
  }, [cameraOn, ensureModels, getVideo, onError, samples.length]);

  /**
   * Register the slot with the ledger, then keep the descriptors here.
   *
   * The order matters. The server owns slot → person; this browser owns the
   * biometric. If the server refuses the slot — already enrolled, unknown
   * person — nothing is saved locally, so the station cannot end up matching a
   * face to a slot the chain will resolve to somebody else.
   */
  const registerSlot = useCallback(async () => {
    if (!identity) {
      setEnrolNote("Pair this browser as a device first.");
      return;
    }
    if (samples.length < SAMPLES_PER_ENROLMENT) {
      setEnrolNote(`Take ${SAMPLES_PER_ENROLMENT} samples before registering.`);
      return;
    }
    const person = persons.find((p) => p.id === personId);
    if (!person) {
      setEnrolNote("Choose who this face belongs to.");
      return;
    }
    // Slot 1 is the superintendent, slot 2 the observer — the same two slots the
    // R307 station uses, so a centre that later fits a reader keeps the mapping.
    const templateSlot = role === "superintendent" ? 1 : 2;
    setBusy("registering the slot");
    try {
      await api.enrolFingerprint({
        deviceId: identity.deviceId,
        templateSlot,
        personId: person.id,
        role,
        fingerLabel: "face (centre PC camera)",
        note: "Enrolled on the face station, not an R307 reader. The biometric is a 128-float descriptor held in this browser; the ledger holds only this slot mapping.",
      });
      const next: FaceEnrolment = {
        templateSlot,
        role,
        personId: person.id,
        personName: person.displayName,
        descriptors: samples,
        enrolledAt: new Date().toISOString(),
        deviceId: identity.deviceId,
      };
      const merged = [...enrolments.filter((e) => e.templateSlot !== templateSlot), next];
      saveEnrolments(merged);
      setEnrolments(merged);
      setSamples([]);
      setPersonId("");
      setEnrolNote(`Slot ${templateSlot} now resolves to ${person.displayName}.`);
    } catch (err) {
      const detail =
        err instanceof ApiError && err.status === 409
          ? `${err.message} — retire it on the Template slots page first.`
          : (err as Error).message;
      setEnrolNote(detail);
    } finally {
      setBusy(null);
    }
  }, [enrolments, identity, personId, persons, role, samples]);

  const forgetFaces = useCallback(() => {
    forgetEnrolments();
    setEnrolments([]);
    setEnrolNote(
      "Descriptors destroyed on this machine. The slot mappings stay in the registry — retire them there if the officials have changed.",
    );
  }, []);

  // ── the ceremony ──────────────────────────────────────────────────────────

  /** Sign and append one event as this browser, reporting a refusal honestly. */
  const post = useCallback(
    async (
      kind: "WITNESS_ASSERTED" | "WITNESS_CEREMONY" | "EXCEPTION_RAISED",
      payload: Record<string, unknown>,
      id: CentreIdentity,
    ): Promise<{ eventId: string; seq: string } | null> => {
      const ctx = getContext();
      if (!ctx.examId) {
        say("No exam id — choose the package this ceremony is opening.");
        return null;
      }
      const body = {
        v: 1 as const,
        id: crypto.randomUUID(),
        examId: ctx.examId,
        ...(ctx.centreId ? { centreId: ctx.centreId } : {}),
        ...(ctx.packageId ? { packageId: ctx.packageId } : {}),
        kind,
        occurredAt: nowTimestamp(),
        actorDeviceId: id.deviceId,
        payload,
      };
      const out = await signAndPost(body as never, id);
      if (out.status === "rejected") {
        say(`The ledger refused the ${kind}: ${out.code}`);
        return null;
      }
      return { eventId: body.id, seq: out.seq };
    },
    [getContext, say],
  );

  const closeSession = useCallback(
    async (session: SessionState, id: CentreIdentity) => {
      if (session.closed) return;
      session.closed = true;

      /**
       * The outcome is read off the window, not chosen.
       *
       * Two distinct slots is the only thing that confirms two people. One slot
       * presented again is recorded as what it was — an attempt at a two-person
       * act by one person — rather than dropped, because the attempt is worth
       * more in the record than its absence.
       */
      const distinct = session.asserted.size >= 2;
      const outcome = distinct
        ? "two_person_confirmed"
        : session.repeats > 0
          ? "same_finger_twice"
          : "window_expired";

      const res = await post(
        "WITNESS_CEREMONY",
        {
          stationId: id.deviceId,
          sessionId: session.id,
          sequence: session.count,
          assertionCount: session.count,
          distinctSlots: distinct,
          windowSeconds: WINDOW_SECONDS,
          outcome,
        },
        id,
      );
      if (res) say(`Window closed as ${outcome}. The access engine decides from here.`);
      setSessionId(null);
      sessionRef.current = null;
      setLive("");
    },
    [post, say],
  );

  /** Commit one assertion, with the frame it was matched on, as one act. */
  const assert = useCallback(
    async (
      session: SessionState,
      enrolment: FaceEnrolment,
      distance: number,
      video: HTMLVideoElement,
      id: CentreIdentity,
    ) => {
      const ctx = getContext();
      const shot = await captureFrame(video);
      const res = await post(
        "WITNESS_ASSERTED",
        {
          stationId: id.deviceId,
          sessionId: session.id,
          sequence: session.count,
          role: enrolment.role,
          templateSlot: enrolment.templateSlot,
          matchScore: scoreFromDistance(distance),
          frameSha256: shot.sha256,
          frameBytes: shot.blob.size,
        },
        id,
      );
      if (!res) return;

      session.count += 1;
      session.asserted.set(enrolment.templateSlot, res.eventId);
      session.unknownStreak = 0;

      /**
       * The frame is stored under the assertion's own id.
       *
       * On the fingerprint path the photograph is a separate `WITNESS_FRAME`
       * signed by the centre PC, because the station has no camera. Here the
       * station *is* the camera, so the hash rides in the assertion itself and
       * there is no second event to bind the image to. It is the same bytes the
       * digest was taken over, so it re-hashes the same way.
       */
      const stored: StoredFrame = {
        id: res.eventId,
        kind: "assertion",
        boundEventId: res.eventId,
        sessionId: session.id,
        packageId: ctx.packageId || null,
        sha256: shot.sha256,
        seq: res.seq,
        capturedAt: new Date().toISOString(),
        width: shot.width,
        height: shot.height,
        bytes: shot.blob.size,
        blob: shot.blob,
        reasons: [],
      };
      await putFrame(stored);

      say(
        `${enrolment.personName} matched as the ${enrolment.role} ` +
          `(slot ${enrolment.templateSlot}, distance ${distance.toFixed(3)}, ` +
          `score ${scoreFromDistance(distance)}).`,
      );

      if (session.asserted.size >= 2) await closeSession(session, id);
    },
    [closeSession, getContext, post, say],
  );

  const startSession = useCallback(async () => {
    if (!identity) {
      say("Pair this browser as a device before starting a ceremony.");
      return;
    }
    if (enrolments.length < 2) {
      say("Two officials have to be enrolled before a two-person window means anything.");
      return;
    }
    if (!cameraOn) {
      say("Start the camera first.");
      return;
    }
    await ensureModels();
    const session: SessionState = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      asserted: new Map(),
      count: 0,
      repeats: 0,
      closed: false,
      unknownStreak: 0,
      exceptionPosted: false,
    };
    sessionRef.current = session;
    setLog([]);
    setRemaining(WINDOW_SECONDS);
    setSessionId(session.id);
    say(`Window open for ${WINDOW_SECONDS} s. Both officials, one at a time.`);
  }, [cameraOn, ensureModels, enrolments.length, identity, say]);

  /**
   * The scan loop.
   *
   * One reading at a time — `inFlight` — because detection on a laptop can take
   * longer than the interval, and two overlapping readings of the same face
   * would post the same assertion twice.
   */
  useEffect(() => {
    if (!sessionId || !identity) return;
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      const session = sessionRef.current;
      if (stopped || inFlight || !session || session.closed) return;
      const video = getVideo();
      if (!video) return;

      const elapsed = (Date.now() - session.startedAt) / 1000;
      setRemaining(Math.max(0, Math.round(WINDOW_SECONDS - elapsed)));
      if (elapsed >= WINDOW_SECONDS) {
        inFlight = true;
        try {
          await closeSession(session, identity);
        } finally {
          inFlight = false;
        }
        return;
      }

      inFlight = true;
      try {
        const reading = await readFace(video);
        if (!reading) {
          setLive("no face in frame");
          return;
        }
        const match = matchFace(reading.descriptor, enrolments);
        if (!match) {
          setLive("nobody enrolled to compare against");
          return;
        }
        if (!match.accepted) {
          session.unknownStreak += 1;
          setLive(
            match.distance <= NEAR_MISS_DISTANCE
              ? `closest is ${match.enrolment.personName} at ${match.distance.toFixed(3)} — ` +
                `not under ${MATCH_DISTANCE}, so it does not count`
              : `no enrolled face matches (closest ${match.distance.toFixed(3)})`,
          );
          if (
            session.unknownStreak >= UNKNOWN_SCANS_BEFORE_EXCEPTION &&
            !session.exceptionPosted
          ) {
            session.exceptionPosted = true;
            await post(
              "EXCEPTION_RAISED",
              {
                code: "biometric_no_match",
                detail:
                  `Face station: ${session.unknownStreak} consecutive readings at the camera ` +
                  `matched no enrolled slot. Closest enrolled descriptor was ` +
                  `${match.distance.toFixed(3)} away, against a threshold of ${MATCH_DISTANCE}.`,
              },
              identity,
            );
            say("Someone unrecognised at the camera — recorded as an exception.");
          }
          return;
        }

        if (session.asserted.has(match.enrolment.templateSlot)) {
          session.repeats += 1;
          setLive(
            `${match.enrolment.personName} has already asserted in this window — ` +
              "one person twice is not two people",
          );
          return;
        }
        setLive(`${match.enrolment.personName} recognised — committing the assertion…`);
        await assert(session, match.enrolment, match.distance, video, identity);
      } catch (err) {
        onError(err as Error);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const t = setInterval(() => void tick(), SCAN_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [assert, closeSession, enrolments, getVideo, identity, onError, post, say, sessionId]);

  // ── render ────────────────────────────────────────────────────────────────

  const bySlot = [...enrolments].sort((a, b) => a.templateSlot - b.templateSlot);

  return (
    <Card
      title="Face station"
      hint="The centre PC's camera standing in for the fingerprint reader — same slots, same assertions, same engine"
    >
      <div className="wit-note">
        This reader is weaker than the R307 and the difference is not cosmetic. The same
        machine matches the face, photographs it and signs both, so control of this browser
        is enough to fabricate a whole ceremony; and there is no liveness test, so a
        printed face held up to the lens can match. See <code>docs/17</code>.
      </div>

      <div className="wit-note">
        {modelState === "ready"
          ? "Recogniser loaded from this origin — no model is fetched from a CDN."
          : modelState === "loading"
            ? "Loading the recogniser (about 6.8 MB, once per page load)…"
            : modelState === "failed"
              ? `The recogniser did not load: ${modelError ?? "unknown reason"}`
              : "The recogniser loads on the first sample or the first ceremony."}
      </div>

      {/* ── enrolment ── */}
      <div className="unlock-inputs">
        <label>
          <span>Who is this face</span>
          <select
            className="wit-select"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
          >
            <option value="">— choose a person on the roster —</option>
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} · {p.role}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Role at the ceremony</span>
          <select
            className="wit-select"
            value={role}
            onChange={(e) => setRole(e.target.value as "superintendent" | "observer")}
          >
            <option value="superintendent">superintendent — slot 1</option>
            <option value="observer">observer — slot 2</option>
          </select>
        </label>
      </div>

      <div className="wit-actions">
        <button
          className="wit-btn ghost"
          onClick={() => void takeSample()}
          disabled={!!busy || !cameraOn || samples.length >= SAMPLES_PER_ENROLMENT}
        >
          Take sample {Math.min(samples.length + 1, SAMPLES_PER_ENROLMENT)} of{" "}
          {SAMPLES_PER_ENROLMENT}
        </button>
        <button
          className="wit-btn"
          onClick={() => void registerSlot()}
          disabled={!!busy || samples.length < SAMPLES_PER_ENROLMENT || !personId}
        >
          Register this face
        </button>
        {samples.length > 0 && (
          <button className="wit-btn ghost" onClick={() => setSamples([])}>
            Discard samples
          </button>
        )}
      </div>
      {enrolNote && <div className="wit-note">{enrolNote}</div>}

      {bySlot.length === 0 ? (
        <div className="wit-note warn">
          Nobody enrolled on this machine. Until two officials are, a ceremony here can only
          close as <code>window_expired</code>.
        </div>
      ) : (
        <ul className="wit-limits">
          {bySlot.map((e) => (
            <li key={e.templateSlot}>
              slot {e.templateSlot} · {e.personName} · {e.role} · {e.descriptors.length}{" "}
              samples held in this browser
            </li>
          ))}
        </ul>
      )}

      {/* ── the window ── */}
      <div className="wit-actions">
        {sessionId ? (
          <button
            className="wit-btn ghost"
            onClick={() => {
              const s = sessionRef.current;
              if (s && identity) void closeSession(s, identity);
            }}
          >
            Close the window now ({remaining}s left)
          </button>
        ) : (
          <button
            className="wit-btn"
            onClick={() => void startSession()}
            disabled={!identity || !cameraOn || enrolments.length < 2}
          >
            Open a two-person window
          </button>
        )}
        {bySlot.length > 0 && (
          <button className="wit-btn ghost" onClick={forgetFaces}>
            Forget the faces
          </button>
        )}
      </div>

      {sessionId && <div className="wit-note">{live || "watching…"}</div>}

      {log.length > 0 && (
        <ul className="wit-limits">
          {log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <code>{l.at}</code> {l.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
