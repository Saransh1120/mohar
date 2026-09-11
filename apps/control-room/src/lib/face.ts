/**
 * ── The face station ─────────────────────────────────────────────────────────
 *
 * `docs/06` specifies an R307 fingerprint reader on an ESP32 as the witness
 * station: two officials, two fingers, one window. This module is a second
 * reader for the same ceremony, built out of the camera that is already on the
 * centre PC, for rooms where no reader has been fitted.
 *
 * It does not change what the ledger records or what the access engine checks.
 * A face match emits exactly the same `WITNESS_ASSERTED` a finger match does —
 * a slot id and a score — and the engine still decides for itself whether two
 * distinct slots asserted inside one window. The recogniser's output is
 * evidence put to the engine, never a verdict.
 *
 * What it is honestly weaker at, stated here rather than in a demo script:
 *
 *   • **One device, not two.** The fingerprint station and the camera are
 *     separate devices, so a substituted photograph has to be paired with a
 *     genuine match on hardware the substituter does not hold. Here the same
 *     browser matches the face, takes the frame and signs both, so control of
 *     this machine is enough to fabricate a whole ceremony. `lib/witness.ts`
 *     already records that the centre PC key is unattested; this makes that gap
 *     wider, not narrower.
 *   • **A camera can be shown a photograph.** There is no liveness test here —
 *     no blink, no depth, no challenge. A printed face at the right distance
 *     will match. A fingerprint reader is not immune either, but it is harder.
 *   • **The descriptors are on this machine.** 128 floats per enrolled person
 *     in `localStorage`, unencrypted, readable by anything with access to this
 *     browser profile. They are not in the chain and never sent to the ledger —
 *     the same stance the fingerprint path takes with templates — but "not in
 *     the database" is not "safe".
 *
 * A descriptor is not reversible into a photograph, which is the one privacy
 * property worth claiming. It is still biometric data about a named person and
 * `forgetEnrolments` exists so it can be destroyed.
 */

import type * as FaceApi from "face-api.js";

/** Where the weights are served from. Vendored under `public/`, never a CDN. */
const MODEL_URL = "/face-models";

const STORAGE_KEY = "mohar.face-station.enrolments";

/**
 * How close two descriptors have to be to count as the same person.
 *
 * face-api's own documented working point is 0.6 on its 128-float embedding.
 * 0.5 is used here because the cost of the two errors is not symmetric: a
 * refused official presents their face again, an accepted stranger opens an
 * examination paper. Anything between the two thresholds is reported as "close,
 * but not close enough" rather than silently dropped, so a genuine official
 * being turned away is visible instead of looking like the camera not working.
 */
export const MATCH_DISTANCE = 0.5;
export const NEAR_MISS_DISTANCE = 0.6;

/** Samples taken per person at enrolment. More angles, fewer false refusals. */
export const SAMPLES_PER_ENROLMENT = 3;

export interface FaceEnrolment {
  /** Same slot space as the fingerprint reader's flash. 1–127. */
  templateSlot: number;
  role: "superintendent" | "observer";
  personId: string;
  personName: string;
  /** One 128-float descriptor per sample. Never leaves this browser. */
  descriptors: number[][];
  enrolledAt: string;
  /** The device this slot was registered against, so a re-paired browser
   *  cannot inherit slots the ledger maps to a different station. */
  deviceId: string;
}

export function loadEnrolments(): FaceEnrolment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FaceEnrolment[];
    return Array.isArray(parsed) ? parsed.filter((e) => e.descriptors?.length > 0) : [];
  } catch {
    return [];
  }
}

export function saveEnrolments(list: FaceEnrolment[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Destroy every descriptor held on this machine. The ledger keeps the slots. */
export function forgetEnrolments(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── the models ──────────────────────────────────────────────────────────────

let api: typeof FaceApi | null = null;
let loading: Promise<typeof FaceApi> | null = null;

/**
 * Load the recogniser.
 *
 * Three nets, roughly 6.8 MB, fetched from this origin. The import is dynamic
 * so a control room that never opens the ceremony page never pays for it, and
 * the promise is cached so a re-render does not start a second download.
 */
export function loadModels(): Promise<typeof FaceApi> {
  if (api) return Promise.resolve(api);
  if (loading) return loading;
  loading = (async () => {
    const faceapi = await import("face-api.js");
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    api = faceapi;
    return faceapi;
  })();
  return loading;
}

export interface FaceReading {
  /** The 128-float embedding of the largest face in the frame. */
  descriptor: number[];
  /** Detector confidence, 0–1. Recorded as evidence, not used as a verdict. */
  detectionScore: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Read one face out of a running video element.
 *
 * Returns `null` when there is no face rather than throwing, because "nobody is
 * in front of the camera" is the ordinary state between assertions and not an
 * error the operator needs to see.
 *
 * Only the single largest detection is used. Two faces in frame is not treated
 * as two officials: the ceremony needs two separate assertions, each with its
 * own frame committed at its own moment, and collapsing them into one reading
 * would let one person hold up a photograph beside their own head.
 */
export async function readFace(video: HTMLVideoElement): Promise<FaceReading | null> {
  const faceapi = await loadModels();
  if (!video.videoWidth) return null;
  const result = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!result) return null;
  const { x, y, width, height } = result.detection.box;
  return {
    descriptor: Array.from(result.descriptor),
    detectionScore: result.detection.score,
    box: { x, y, width, height },
  };
}

// ── matching ────────────────────────────────────────────────────────────────

export function distance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export interface FaceMatch {
  enrolment: FaceEnrolment;
  /** Euclidean distance to the closest enrolled sample. Lower is closer. */
  distance: number;
  /** True only under `MATCH_DISTANCE`. Between the thresholds this is false. */
  accepted: boolean;
}

/**
 * Closest enrolled person to this reading.
 *
 * Returns the nearest candidate even when it is too far to accept, so the panel
 * can say "closest was Anita at 0.54, which is not close enough" instead of the
 * unhelpful "no match". Nothing downstream reads `distance` without also
 * reading `accepted`.
 */
export function matchFace(
  descriptor: number[],
  enrolments: FaceEnrolment[],
): FaceMatch | null {
  let best: FaceMatch | null = null;
  for (const e of enrolments) {
    for (const sample of e.descriptors) {
      const d = distance(descriptor, sample);
      if (!best || d < best.distance) {
        best = { enrolment: e, distance: d, accepted: d <= MATCH_DISTANCE };
      }
    }
  }
  return best;
}

/**
 * The number the chain records for a match.
 *
 * `WITNESS_ASSERTED.matchScore` is documented as "reader confidence, roughly
 * 0–255, recorded as evidence, not as a verdict" — the R307 returns one and so
 * must this reader. Distance is mapped onto that range so the two readers'
 * scores are at least read the same way round: higher is closer. It is not the
 * R307's number and does not mean the same thing, which is why the panel prints
 * the raw distance beside it.
 */
export function scoreFromDistance(d: number): number {
  const scaled = Math.round((1 - Math.min(d, 1)) * 255);
  return Math.max(0, Math.min(255, scaled));
}
