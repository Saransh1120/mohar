import {
  generateContentKey,
  sealContent,
  openSeal,
  splitContentKey,
  combineContentKey,
  generateKeypair,
  signBody,
  type SealedContent,
  type CommittedShare,
  type SplitResult,
} from "@mohar/crypto-core";

/**
 * ── The end-to-end demonstration ─────────────────────────────────────────────
 *
 * One page has to show a paper being sealed, locked behind a split key, refused,
 * authorised, and opened — in about three minutes, to somebody who has never
 * seen the system. The temptation in that situation is to animate it. This
 * module exists to make sure nothing here is animated.
 *
 * Every cryptographic operation below is the same code the rest of the system
 * uses: `sealContent` is the real AEAD, `splitContentKey` is the real Shamir,
 * `signBody` is the real Ed25519 over the real RFC 8785 canonical form, and
 * every event posted lands in the real chain and is refused by the real ledger
 * if it is wrong. The two-shares-fail demonstration fails because the library
 * genuinely refuses, not because a branch was written to say so.
 *
 * ── What *is* simulated, and why it is labelled ──
 *
 * The fingerprint reader. A grant requires two biometric assertions, and with no
 * R307 on the desk there is nothing to read a finger. So the demo enrols a
 * station device and signs `WITNESS_ASSERTED` as it. Those events are real —
 * really signed, really chained, really evaluated by the access engine — but the
 * *hardware input* behind them is fabricated, and every surface that shows them
 * says so. That distinction is the entire honesty of this page: simulated input,
 * real machinery. Blur it and the demonstration proves nothing.
 */

// ── the paper ───────────────────────────────────────────────────────────────

export const DEMO_PAPER = `DEMO EXAM PAPER — MATHEMATICS
State Services Preliminary Examination
Duration: 3 hours                            Maximum marks: 100

CANDIDATE INSTRUCTIONS
1. Write your roll number in the space provided. Do not write your name.
2. All questions are compulsory. Each question carries equal marks.
3. Calculators are not permitted.
4. Hand this paper back to the invigilator before leaving the hall.

--------------------------------------------------------------------

Q1.  Solve for x:      2x + 3 = 11

Q2.  A train travels 180 km in 2 hours 30 minutes.
     Find its average speed in km/h.

Q3.  The angles of a triangle are in the ratio 2 : 3 : 4.
     Find each angle.

Q4.  Find the compound interest on Rs. 12,000 at 8% per annum
     for 2 years, compounded annually.

Q5.  If sin θ = 3/5 and θ is acute, find the value of
     cos θ and tan θ.

--------------------------------------------------------------------
END OF PAPER

THIS IS DEMONSTRATION CONTENT. It exists so that the encryption,
key-splitting and authorisation steps operate on a real document
rather than on a placeholder string.`;

// ── the demo's own signing identity ─────────────────────────────────────────

const IDENTITY_KEY = "mohar.demo.identity";

export interface DemoIdentity {
  /** Signs `PACKAGE_SEALED`. Enrolled as `service` because that kind is what the
   *  ledger requires for service-only event kinds. */
  sealerDeviceId: string;
  sealerPrivateKeyHex: string;
  /** Signs the witness assertions. Enrolled as `monitor`, bound to the centre,
   *  because the engine checks a station's binding rather than a position fix. */
  stationDeviceId: string;
  stationPrivateKeyHex: string;
  /** Signs `WITNESS_FRAME`. Enrolled as `centre_pc` because the camera really is
   *  this laptop's — signing the frame as the station would put the station's
   *  name on a photograph it did not take. */
  terminalDeviceId: string;
  terminalPrivateKeyHex: string;
  centreId: string;
}

export function loadDemoIdentity(): DemoIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as DemoIdentity) : null;
  } catch {
    return null;
  }
}

export function forgetDemoIdentity(): void {
  localStorage.removeItem(IDENTITY_KEY);
}

async function enrolDevice(kind: string, centreId?: string) {
  const kp = generateKeypair();
  const res = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, pubkeyHex: kp.publicKeyHex, ...(centreId ? { centreId } : {}) }),
  });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `enrolment failed (${res.status})`);
  return { deviceId: body.id, privateKeyHex: kp.privateKeyHex };
}

/**
 * Two identities, deliberately separate.
 *
 * One device signing both the seal and the witness assertions would be a single
 * key standing in for the preparation authority and for the station in the room,
 * and the chain would then record a two-person ceremony attested by one key. The
 * separation costs one extra enrolment and keeps the record meaning what it says.
 */
export async function ensureDemoIdentity(centreId: string): Promise<DemoIdentity> {
  const existing = loadDemoIdentity();
  if (existing && existing.centreId === centreId) return existing;

  const sealer = await enrolDevice("service");
  const station = await enrolDevice("monitor", centreId);
  const terminal = await enrolDevice("centre_pc", centreId);
  const identity: DemoIdentity = {
    sealerDeviceId: sealer.deviceId,
    sealerPrivateKeyHex: sealer.privateKeyHex,
    stationDeviceId: station.deviceId,
    stationPrivateKeyHex: station.privateKeyHex,
    terminalDeviceId: terminal.deviceId,
    terminalPrivateKeyHex: terminal.privateKeyHex,
    centreId,
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

// ── posting, with an offline spool in the middle ────────────────────────────

export type PostOutcome =
  | { status: "appended"; seq: string; hash: string }
  | { status: "duplicate"; seq: string }
  | { status: "rejected"; code: string; detail: string };

export interface SignedEvent {
  body: Record<string, unknown>;
  deviceSig: string;
  /** Present on the kinds the ledger will not accept from one device alone. */
  cosignDeviceId?: string;
  cosignSig?: string;
  /** Set once the ledger has taken it. Undefined while spooled. */
  seq?: string;
  hash?: string;
}

/**
 * Build and sign, without sending.
 *
 * Separating this from the send is what makes the offline demonstration honest:
 * the record is complete and signed at the moment the act happened, and going
 * offline delays its delivery rather than its creation. The event id is fixed
 * here too, so the same record is re-sent on reconnection — not a new one
 * standing in for it.
 */
export function buildSigned(
  body: Record<string, unknown>,
  privateKeyHex: string,
): SignedEvent {
  return { body, deviceSig: signBody(body, privateKeyHex) };
}

export async function sendSigned(ev: SignedEvent): Promise<PostOutcome> {
  const res = await fetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: ev.body,
      deviceSig: ev.deviceSig,
      ...(ev.cosignDeviceId && ev.cosignSig
        ? { cosignDeviceId: ev.cosignDeviceId, cosignSig: ev.cosignSig }
        : {}),
    }),
  });
  const out = (await res.json()) as Record<string, unknown>;
  if (res.status === 201) {
    return { status: "appended", seq: String(out["seq"]), hash: String(out["hash"]) };
  }
  if (res.status === 200) return { status: "duplicate", seq: String(out["seq"]) };
  return {
    status: "rejected",
    code: String(out["code"] ?? "unknown"),
    detail: JSON.stringify(out),
  };
}

const nowTimestamp = (): string => new Date().toISOString();

// ── stage 1: seal the paper ─────────────────────────────────────────────────

export interface SealedPackage {
  packageId: string;
  sealed: SealedContent;
  split: SplitResult;
  /** Held only so the demo can show that three shares reproduce it exactly. */
  contentKey: Uint8Array;
}

/** Encrypt the paper and split its key. Nothing here touches the network. */
export async function sealDemoPaper(packageId: string): Promise<SealedPackage> {
  const contentKey = generateContentKey();
  const sealed = sealContent(DEMO_PAPER, contentKey, packageId);
  const split = await splitContentKey(contentKey);
  return { packageId, sealed, split, contentKey };
}

/**
 * Commit the seal to the chain.
 *
 * What goes in is the ciphertext's digest and one commitment per share — not the
 * ciphertext and not the shares. The chain's job is to make it impossible to
 * later claim a different document was sealed, and a digest does that without
 * the ledger becoming the place the paper is stored.
 */
export function buildSealEvent(
  pkg: SealedPackage,
  examId: string,
  centreId: string,
  identity: DemoIdentity,
  copies: number,
  drandRound: number,
): SignedEvent {
  const body = {
    v: 1,
    id: crypto.randomUUID(),
    examId,
    centreId,
    packageId: pkg.packageId,
    kind: "PACKAGE_SEALED",
    occurredAt: nowTimestamp(),
    actorDeviceId: identity.sealerDeviceId,
    payload: {
      copies,
      ciphertextSha256: pkg.sealed.ciphertextSha256,
      drandRound,
      shareCommitments: pkg.split.shares.map((s) => s.commitment),
    },
  };
  return buildSigned(body, identity.sealerPrivateKeyHex);
}

// ── stage 2: the ceremony, with simulated hardware input ────────────────────

export interface CeremonyPlan {
  sessionId: string;
  events: SignedEvent[];
}

/**
 * A photograph of the terminal, committed by hash and bound to one assertion.
 *
 * This is what lets `witness_capture` pass honestly: the check accepts a frame
 * from the station or from the centre PC, and this is genuinely the centre PC's
 * camera. Without it the engine refuses — correctly — because a ceremony nobody
 * photographed is a ceremony with no evidence of who was standing there.
 */
export function buildFrameEvent(
  examId: string,
  centreId: string,
  packageId: string,
  identity: DemoIdentity,
  sessionId: string,
  assertionEventId: string,
  shot: { sha256: string; bytes: number; width: number; height: number },
): SignedEvent {
  return buildSigned(
    {
      v: 1,
      id: crypto.randomUUID(),
      examId,
      centreId,
      packageId,
      kind: "WITNESS_FRAME",
      occurredAt: nowTimestamp(),
      actorDeviceId: identity.terminalDeviceId,
      payload: {
        sessionId,
        assertionEventId,
        frameSha256: shot.sha256,
        frameBytes: shot.bytes,
        width: shot.width,
        height: shot.height,
      },
    },
    identity.terminalPrivateKeyHex,
  );
}

/**
 * Two assertions and an outcome, as the station would have signed them.
 *
 * `frameSha256` is the digest of the frame the station captured. There is no
 * camera on the station, so the demo has no frame to hash and sends the
 * all-zero digest with `frameBytes: 0` — which the payload defines as "no frame
 * was captured", stated rather than left to inference. Inventing a plausible
 * digest here would be inventing evidence.
 */
export function buildCeremony(
  examId: string,
  centreId: string,
  packageId: string,
  identity: DemoIdentity,
  slots: { superintendent: number; observer: number },
): CeremonyPlan {
  const sessionId = crypto.randomUUID();
  const noFrame = "0".repeat(64);
  const base = { v: 1, examId, centreId, packageId, actorDeviceId: identity.stationDeviceId };

  const assertion = (role: "superintendent" | "observer", slot: number, seq: number) =>
    buildSigned(
      {
        ...base,
        id: crypto.randomUUID(),
        kind: "WITNESS_ASSERTED",
        occurredAt: nowTimestamp(),
        payload: {
          stationId: identity.stationDeviceId,
          sessionId,
          sequence: seq,
          role,
          templateSlot: slot,
          matchScore: role === "superintendent" ? 187 : 174,
          frameSha256: noFrame,
          frameBytes: 0,
        },
      },
      identity.stationPrivateKeyHex,
    );

  const ceremony = buildSigned(
    {
      ...base,
      id: crypto.randomUUID(),
      kind: "WITNESS_CEREMONY",
      occurredAt: nowTimestamp(),
      payload: {
        stationId: identity.stationDeviceId,
        sessionId,
        sequence: 3,
        assertionCount: 2,
        distinctSlots: true,
        windowSeconds: 120,
        outcome: "two_person_confirmed",
      },
    },
    identity.stationPrivateKeyHex,
  );

  return {
    sessionId,
    events: [
      assertion("superintendent", slots.superintendent, 1),
      assertion("observer", slots.observer, 2),
      ceremony,
    ],
  };
}

// ── the journey: press to centre ────────────────────────────────────────────

/**
 * The part of the workflow that actually carries the risk.
 *
 * A paper is not usually stolen out of a strong room; it goes missing somewhere
 * between the press and the hall, during the hours it spends in a vehicle and in
 * somebody's custody overnight. Those hours are exactly what a paper register
 * describes worst, so a demonstration that jumps from sealing to unlocking skips
 * the stretch the system exists for.
 *
 * Each hop below is a real signed event. `HANDOFF` is in the ledger's
 * co-signature set, so each one carries two signatures from two different
 * enrolled devices — a handover attested by one device is one person's word,
 * which is the thing being replaced.
 */
export interface JourneyPerson {
  personId: string;
  displayName: string;
  role: string;
}

export interface JourneyHop {
  label: string;
  stage: string;
  event: SignedEvent;
}

export interface PhotoDigest {
  sha256: string;
}

/**
 * Build the transport chain.
 *
 * `photoAt` is called once per hop that requires a photograph, because
 * `SEAL_APPLIED` and `HANDOFF` both demand one and a handover with no picture of
 * it is a row in a register again. If the caller has no camera it must say so
 * rather than supply a digest of nothing.
 */
export function buildJourney(
  examId: string,
  centreId: string,
  packageId: string,
  sealSerial: string,
  identity: DemoIdentity,
  cast: {
    districtOfficer: JourneyPerson;
    courier: JourneyPerson;
    custodian: JourneyPerson;
    superintendent: JourneyPerson;
  },
  photoAt: (label: string) => PhotoDigest,
): JourneyHop[] {
  const base = { v: 1, examId, centreId, packageId };

  /** Both signatures, from two devices that are genuinely not the same one. */
  const cosigned = (body: Record<string, unknown>): SignedEvent => {
    const ev = buildSigned(body, identity.stationPrivateKeyHex);
    return {
      ...ev,
      cosignDeviceId: identity.terminalDeviceId,
      cosignSig: signBody(body, identity.terminalPrivateKeyHex),
    };
  };

  const handoff = (
    label: string,
    stage: string,
    from: JourneyPerson,
    to: JourneyPerson,
    toState: string,
  ): JourneyHop => ({
    label,
    stage,
    event: cosigned({
      ...base,
      id: crypto.randomUUID(),
      kind: "HANDOFF",
      occurredAt: nowTimestamp(),
      actorDeviceId: identity.stationDeviceId,
      actorPersonId: from.personId,
      payload: {
        fromPersonId: from.personId,
        toPersonId: to.personId,
        fromRole: from.role,
        toRole: to.role,
        sealSerial,
        photoSha256: photoAt(label).sha256,
        toState,
      },
    }),
  });

  const scan = (label: string, identifier: string): JourneyHop => ({
    label,
    stage: "transit",
    event: buildSigned(
      {
        ...base,
        id: crypto.randomUUID(),
        kind: "SCAN_OBSERVED",
        occurredAt: nowTimestamp(),
        actorDeviceId: identity.stationDeviceId,
        payload: { scanType: "qr", rawIdentifier: identifier },
      },
      identity.stationPrivateKeyHex,
    ),
  });

  return [
    {
      label: "Seal applied at the press",
      stage: "seal",
      event: buildSigned(
        {
          ...base,
          id: crypto.randomUUID(),
          kind: "SEAL_APPLIED",
          occurredAt: nowTimestamp(),
          actorDeviceId: identity.stationDeviceId,
          actorPersonId: cast.districtOfficer.personId,
          payload: { sealSerial, photoSha256: photoAt("Seal applied at the press").sha256 },
        },
        identity.stationPrivateKeyHex,
      ),
    },
    handoff("Dispatched to the courier", "dispatch", cast.districtOfficer, cast.courier, "in_transit"),
    scan("Checkpoint scan — district border", `${sealSerial}#CP1`),
    scan("Checkpoint scan — city entry", `${sealSerial}#CP2`),
    handoff("Received into overnight custody", "custodian", cast.courier, cast.custodian, "at_custodian"),
    handoff("Delivered to the centre", "centre", cast.custodian, cast.superintendent, "at_centre"),
  ];
}

// ── stage 3: recovery and opening ───────────────────────────────────────────

export interface RecoveryAttempt {
  ok: boolean;
  used: number;
  detail: string;
  /** Present only on success — and only ever held for the length of the demo. */
  key?: Uint8Array;
}

/**
 * Try to rebuild the content key from a subset of shares.
 *
 * Two shares fail here because `combineContentKey` refuses below the threshold,
 * not because this function checks a count first. The distinction matters: what
 * the page shows is the library declining, which is the property being claimed.
 */
export async function tryRecover(
  shares: readonly CommittedShare[],
  secretCommitment: string,
): Promise<RecoveryAttempt> {
  try {
    const key = await combineContentKey(shares, secretCommitment);
    return {
      ok: true,
      used: shares.length,
      detail: `${shares.length} shares reconstructed the content key and it matches the commitment recorded at sealing`,
      key,
    };
  } catch (err) {
    return { ok: false, used: shares.length, detail: (err as Error).message };
  }
}

/** Open the sealed paper. Throws if the key is wrong or the bytes were altered. */
export function openDemoPaper(pkg: SealedPackage, key: Uint8Array): string {
  return openSeal(pkg.sealed, key, pkg.packageId);
}

/** Shares in the order the demo hands them over, so the UI can slice a subset. */
export const shareSubset = (split: SplitResult, n: number): CommittedShare[] =>
  split.shares.slice(0, n);
