import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  captureFrame,
  loadIdentity,
  pairThisBrowser,
  forgetIdentity,
  nowTimestamp,
  signAndPost,
  type CentreIdentity,
} from "./witness";
import { allFrames, putFrame, type StoredFrame } from "./frameStore";
import { useEventStream, type ChainEvent, type StreamState } from "./useEventStream";
import { api } from "./api";

/**
 * ── Evidence capture, lifted out of any one page ─────────────────────────────
 *
 * The camera used to live inside the Ceremony page, which meant a refusal was
 * photographed only while an operator happened to have that tab in front of
 * them. That is the wrong dependency: whether a refused unlock has a photograph
 * should not turn on which page somebody was reading.
 *
 * So the stream, the camera and the capture rules live here, mounted once for
 * the whole app. Pages borrow them; none of them own them.
 *
 * **One stream, not two.** This provider holds the app's single
 * `useEventStream` and re-broadcasts to whoever subscribes. A page that opened
 * its own `EventSource` would double every delivery and give the browser two
 * connections to reconnect on a dropped link.
 *
 * **What takes the photograph.** This machine's camera. The ESP32 at the
 * station reads the finger and has no camera fitted — `WitnessNode.ino` says so
 * about itself — so the division of labour is that the station decides
 * something failed and this browser photographs the room when it hears. The
 * honest consequence, stated on the page as well as here: the face in the frame
 * is whoever is in front of *this* machine. When a station with a camera
 * commits its own frame, `stationFrameFor` finds it and the page prefers it.
 *
 * **When it fires.** Two events, and nothing else — a refused access decision,
 * and an `EXCEPTION_RAISED` carrying a `biometric_*` code. Never on a timer,
 * never on motion, never on a granted unlock.
 */

/**
 * Whether the operator has armed the camera.
 *
 * Kept because the alternative was worse in practice: the camera had to be
 * started by hand after every reload and on every fresh tab, so the usual state
 * of the system was "refusals are happening and nothing is photographing them",
 * and nobody found out until they looked at an empty card. Arming is a decision
 * the operator makes once; forgetting it every few minutes is not a safety
 * feature, it is a way of losing evidence quietly.
 */
const ARMED_KEY = "mohar.evidence.camera-armed";

const readArmed = (): boolean => {
  try {
    return localStorage.getItem(ARMED_KEY) === "on";
  } catch {
    return false;
  }
};

const writeArmed = (on: boolean): void => {
  try {
    localStorage.setItem(ARMED_KEY, on ? "on" : "off");
  } catch {
    // A profile that refuses storage simply does not remember. The camera still
    // works; it just has to be started by hand, which is where this came in.
  }
};

/** Never two captures inside this window, however many refusals arrive. */
const MIN_CAPTURE_INTERVAL_MS = 2500;

/**
 * Rejections that will not come right on their own.
 *
 * A revoked device stays revoked; a bad signature stays bad. Retrying those is
 * not resilience, it is a loop — one revoked key produced two hundred rejected
 * appends and, because nothing surfaced them, a page that quietly said "no
 * photograph" while hammering the ledger twice a second. Permanent rejections
 * are recorded as handled so the attempt is made once and the operator is told
 * what to fix.
 */
const PERMANENT_REJECTIONS = new Set([
  "device_revoked",
  "device_unknown",
  "signature_invalid",
  "schema_invalid",
  "service_only_kind",
]);

export interface RefusalSubject {
  /** Stable key for "this refusal", so redelivery cannot double-photograph it. */
  key: string;
  attemptId?: string;
  decisionEventId?: string;
  exceptionEventId?: string;
  examId: string;
  centreId?: string;
  packageId?: string;
  sessionId: string | null;
  reasons: string[];
}

type ChainListener = (e: ChainEvent) => void;

interface Evidence {
  identity: CentreIdentity | null;
  pairing: boolean;
  pair: () => Promise<void>;
  forget: () => void;

  cameraOn: boolean;
  cameraError: string | null;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
  /** Point a <video> at the shared stream. Pass null on unmount. */
  attachPreview: (el: HTMLVideoElement | null) => void;

  /** The one SSE link. `"live"`, `"connecting"` or `"down"`. */
  stream: StreamState;
  /** Subscribe to chain events. Returns an unsubscribe. */
  subscribe: (fn: ChainListener) => () => void;

  frames: StoredFrame[];
  refreshFrames: () => Promise<void>;

  /** Photograph a refusal now. Safe to call twice for the same key. */
  capture: (subject: RefusalSubject) => Promise<void>;
  busy: string | null;
  lastError: Error | null;
}

const Ctx = createContext<Evidence | null>(null);

export function useEvidence(): Evidence {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEvidence must be used inside <EvidenceProvider>");
  return ctx;
}

/** The event body, once past the hook's deliberately loose typing. */
interface EventBodyish {
  id: string;
  examId: string;
  centreId?: string;
  packageId?: string;
  occurredAt: string;
  actorDeviceId: string;
  payload: Record<string, unknown>;
}

const bodyOf = (e: ChainEvent): EventBodyish => e.body as unknown as EventBodyish;

export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<CentreIdentity | null>(() => loadIdentity());
  const [pairing, setPairing] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [frames, setFrames] = useState<StoredFrame[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  /**
   * A detached <video> the camera always runs into.
   *
   * `captureFrame` needs an element with real dimensions, and a page's preview
   * may be unmounted at the moment a refusal arrives. Keeping one off the
   * document means capture never depends on what happens to be rendered.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const doneRef = useRef<Set<string>>(new Set());
  const lastCaptureRef = useRef(0);
  const identityRef = useRef<CentreIdentity | null>(identity);
  identityRef.current = identity;
  const cameraOnRef = useRef(false);
  cameraOnRef.current = cameraOn;

  if (!videoRef.current && typeof document !== "undefined") {
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    videoRef.current = el;
  }

  const refreshFrames = useCallback(async () => {
    setFrames(await allFrames());
  }, []);

  useEffect(() => {
    void refreshFrames();
  }, [refreshFrames]);

  // ── camera ────────────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    if (streamRef.current) {
      writeArmed(true);
      setCameraOn(true);
      return;
    }
    setCameraError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = media;
      if (videoRef.current) {
        videoRef.current.srcObject = media;
        await videoRef.current.play();
      }
      if (previewRef.current) {
        previewRef.current.srcObject = media;
        await previewRef.current.play().catch(() => undefined);
      }
      writeArmed(true);
      setCameraOn(true);
    } catch (err) {
      // Naming the cause matters: "denied" is a decision the operator can undo,
      // "insecure origin" is a deployment problem, and the two look identical
      // from the outside.
      const e = err as Error;
      setCameraError(
        e.name === "NotAllowedError"
          ? "Camera permission was refused. Allow it in the browser's site settings and press Start again."
          : e.name === "NotFoundError"
            ? "No camera was found on this machine."
            : !window.isSecureContext
              ? "The browser only grants camera access on localhost or HTTPS."
              : e.message,
      );
      setCameraOn(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    // Stopping is a decision too, and it has to survive a reload — otherwise an
    // operator who deliberately turned the camera off finds it on again.
    writeArmed(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  const attachPreview = useCallback((el: HTMLVideoElement | null) => {
    previewRef.current = el;
    if (el && streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
  }, []);

  /**
   * Re-arm on load, but only where the browser has already said yes.
   *
   * `navigator.permissions` is consulted first so a reload never produces a
   * permission prompt the operator did not ask for — a page that demands the
   * camera on sight is a page people learn to click "block" on, and then the
   * feature is off permanently. Where the query is unsupported the flag alone
   * is trusted, because it can only have been set by the operator pressing
   * Start.
   */
  useEffect(() => {
    if (!readArmed()) return;
    let cancelled = false;

    void (async () => {
      try {
        const perms = navigator.permissions as
          | { query?: (d: { name: string }) => Promise<{ state: string }> }
          | undefined;
        if (perms?.query) {
          const status = await perms.query({ name: "camera" });
          if (status.state === "denied") return;
          if (status.state === "prompt") return;
        }
      } catch {
        // Firefox rejects `{ name: "camera" }` outright. Falling through to the
        // stored flag is right: it was set by a successful grant.
      }
      if (!cancelled) await startCamera();
    })();

    return () => {
      cancelled = true;
    };
  }, [startCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ── capture ───────────────────────────────────────────────────────────────

  const capture = useCallback(async (subject: RefusalSubject) => {
    const id = identityRef.current;
    const video = videoRef.current;
    if (!id || !video || !cameraOnRef.current) return;
    if (doneRef.current.has(subject.key)) return;

    // Debounce as well as de-duplicate. A reader being jabbed repeatedly
    // produces a burst of distinct refusals, and a photograph of each fills the
    // store with near-identical frames of one person doing one thing — closer
    // to surveillance than to evidence.
    const now = Date.now();
    if (now - lastCaptureRef.current < MIN_CAPTURE_INTERVAL_MS) return;

    doneRef.current.add(subject.key);
    lastCaptureRef.current = now;
    setBusy("photographing the terminal");
    try {
      const shot = await captureFrame(video);
      const body = {
        v: 1 as const,
        id: crypto.randomUUID(),
        examId: subject.examId,
        ...(subject.centreId ? { centreId: subject.centreId } : {}),
        ...(subject.packageId ? { packageId: subject.packageId } : {}),
        kind: "ACCESS_FRAME" as const,
        occurredAt: nowTimestamp(),
        actorDeviceId: id.deviceId,
        payload: {
          ...(subject.attemptId ? { attemptId: subject.attemptId } : {}),
          ...(subject.decisionEventId ? { decisionEventId: subject.decisionEventId } : {}),
          ...(subject.exceptionEventId ? { exceptionEventId: subject.exceptionEventId } : {}),
          frameSha256: shot.sha256,
          frameBytes: shot.blob.size,
          width: shot.width,
          height: shot.height,
        },
      };
      const out = await signAndPost(body as never, id);
      if (out.status === "rejected") {
        // Transient causes — an unreachable ledger mid-append, a clock that has
        // not synced — are worth another go on the next refusal. Permanent ones
        // are not, and retrying them is what turned one revoked key into two
        // hundred rejected appends.
        if (!PERMANENT_REJECTIONS.has(out.code)) doneRef.current.delete(subject.key);
        setLastError(
          new Error(
            out.code === "device_revoked"
              ? "This browser's signing key has been revoked, so the ledger will not accept its photographs. Open the Ceremony page, press “Forget this key”, then pair again."
              : out.code === "device_unknown"
                ? "This browser's signing key is not enrolled. Open the Ceremony page and pair again."
                : `The ledger refused the photograph: ${out.code}.`,
          ),
        );
        return;
      }
      const stored: StoredFrame = {
        id: body.id,
        kind: "refusal",
        boundEventId:
          subject.attemptId ?? subject.exceptionEventId ?? subject.decisionEventId ?? subject.key,
        sessionId: subject.sessionId,
        packageId: subject.packageId ?? null,
        sha256: shot.sha256,
        seq: out.seq,
        capturedAt: body.occurredAt,
        width: shot.width,
        height: shot.height,
        bytes: shot.blob.size,
        blob: shot.blob,
        reasons: subject.reasons,
      };
      await putFrame(stored);
      setFrames((f) => [stored, ...f]);
    } catch (err) {
      doneRef.current.delete(subject.key);
      setLastError(err as Error);
    } finally {
      setBusy(null);
    }
  }, []);

  // ── the one stream ────────────────────────────────────────────────────────

  const listenersRef = useRef<Set<ChainListener>>(new Set());

  const subscribe = useCallback((fn: ChainListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  /**
   * Which exam and centre this chain is about.
   *
   * A refused attempt names a package, not an exam, and the event envelope
   * requires an exam id. Any event on the stream supplies one, so the first
   * that arrives fills this in.
   */
  const examHintRef = useRef<{ examId: string; centreId?: string }>({ examId: "" });

  const onEvent = useCallback(
    (e: ChainEvent) => {
      const hint = bodyOf(e);
      if (hint?.examId) {
        examHintRef.current = {
          examId: hint.examId,
          ...(hint.centreId ? { centreId: hint.centreId } : {}),
        };
      }
      for (const fn of listenersRef.current) {
        try {
          fn(e);
        } catch {
          // One page throwing must not stop the others from being told.
        }
      }

      if (e.kind !== "EXCEPTION_RAISED") return;
      const b = bodyOf(e);
      const code = String(b.payload?.["code"] ?? "");
      if (!code.startsWith("biometric_")) return;

      void capture({
        key: `exception:${b.id}`,
        exceptionEventId: b.id,
        examId: b.examId,
        ...(b.centreId ? { centreId: b.centreId } : {}),
        ...(b.packageId ? { packageId: b.packageId } : {}),
        sessionId: null,
        reasons: [code],
      });
    },
    [capture],
  );

  const stream = useEventStream(onEvent, { afterSeq: "0" });

  /**
   * Refused decisions, which the stream cannot carry.
   *
   * `/access/request` records the attempt and returns without appending
   * anything to the chain — that would need a signing identity the service
   * deliberately does not have. So a refused unlock produces no event, and the
   * one refusal most worth a photograph would be the one the stream never
   * mentions. This watches the attempt table instead.
   *
   * Everything already refused when this mounts is marked handled rather than
   * photographed. The camera pointing at the room now has nothing to say about
   * who was standing there for a refusal from this morning, and committing that
   * frame would attach a face to an attempt it had no part in.
   */
  const primedRef = useRef(false);

  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      try {
        const { attempts } = await api.attempts({ outcome: "denied", limit: 20 });
        if (stopped) return;

        if (!primedRef.current) {
          for (const a of attempts) doneRef.current.add(`attempt:${a.id}`);
          primedRef.current = true;
          return;
        }

        // Oldest first, so a burst is photographed in the order it happened
        // rather than the order the query returned.
        for (const a of [...attempts].reverse()) {
          const key = `attempt:${a.id}`;
          if (doneRef.current.has(key)) continue;
          await capture({
            key,
            attemptId: a.id,
            ...(a.eventId ? { decisionEventId: a.eventId } : {}),
            examId: examHintRef.current.examId,
            ...(examHintRef.current.centreId ? { centreId: examHintRef.current.centreId } : {}),
            ...(a.packageId ? { packageId: a.packageId } : {}),
            sessionId: a.sessionId,
            reasons: a.denyReasons?.length ? a.denyReasons : ["access_denied"],
          });
        }
      } catch {
        // A failed read is not worth surfacing: the next tick retries, and the
        // Failed Attempts page reports the same outage on its own fetch.
      }
    };

    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [capture]);

  // ── pairing ───────────────────────────────────────────────────────────────

  const pair = useCallback(async () => {
    setPairing(true);
    setLastError(null);
    try {
      setIdentity(await pairThisBrowser());
    } catch (err) {
      setLastError(err as Error);
    } finally {
      setPairing(false);
    }
  }, []);

  const forget = useCallback(() => {
    forgetIdentity();
    setIdentity(null);
  }, []);

  const value = useMemo<Evidence>(
    () => ({
      identity,
      pairing,
      pair,
      forget,
      cameraOn,
      cameraError,
      startCamera,
      stopCamera,
      attachPreview,
      stream,
      subscribe,
      frames,
      refreshFrames,
      capture,
      busy,
      lastError,
    }),
    [
      identity,
      pairing,
      pair,
      forget,
      cameraOn,
      cameraError,
      startCamera,
      stopCamera,
      attachPreview,
      stream,
      subscribe,
      frames,
      refreshFrames,
      capture,
      busy,
      lastError,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
