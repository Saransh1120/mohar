import { useSyncExternalStore } from "react";
import { digestKey, generateSeamToken, seamCommitment, seamTokenToHex } from "@mohar/crypto-core";
import { api, type AccessDecisionResult, type PackageSummary, type RosterEntry } from "./api";
import { captureFrame } from "./witness";
import { putFrame } from "./frameStore";
import {
  buildAccessFrameEvent,
  buildCeremony,
  buildFrameEvent,
  buildJourney,
  buildSealEvent,
  digestOf,
  ensureDemoIdentity,
  openDemoPaper,
  sealDemoPaper,
  sendSigned,
  shareSubset,
  tryRecover,
  type JourneyHop,
  type SignedEvent,
} from "./liveDemo";

/**
 * ── The whole demonstration, driven across every screen ──────────────────────
 *
 * One click seals a paper, carries it to the centre, runs the ceremony, asks
 * the access engine three times and opens the paper — and after each act it
 * takes the room to the screen where that act now shows up: the device list,
 * the activity ledger, the slot register, the refused attempts, the chain.
 *
 * It lives outside any page because it has to survive leaving every page. It
 * holds its own camera for the same reason: the Live Demo page's video element
 * is gone the moment the run navigates away from it.
 *
 * Nothing here decides an outcome. Each step calls the same library functions
 * and the same ledger the individual buttons do. A refusal is the engine's, the
 * grant is the engine's, and if any step fails the run stops there, on screen,
 * with what failed and how to fix it. The only simulated input is the
 * fingerprint reader, and every caption that touches it says so.
 */

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * This laptop's memory for the run. A custody key's plaintext is handed out once
 * per six-hour window and a seam token is never kept by the server, so without
 * this a second run stops at the key, or at a flap code nobody can show again.
 * Same store and same trust the page already gives the demo devices' keys.
 */
const readStore = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeStore = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode — the run still works, once */
  }
};
const removeStore = (k: string): void => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* nothing to remove */
  }
};

// ── observable state ────────────────────────────────────────────────────────

export interface RunStep {
  label: string;
  state: "running" | "done" | "failed";
  detail?: string;
}

export interface RunSnapshot {
  active: boolean;
  steps: RunStep[];
  /** The screen the room is looking at and what to look for on it. */
  screen: { title: string; caption: string } | null;
  /** The decrypted paper, once and only if the engine granted. */
  paper: string | null;
  outcome: "ok" | "failed" | null;
  /** Set while the run is waiting for someone in the room to type something. */
  prompt: { question: string; hint: string } | null;
}

let snap: RunSnapshot = {
  active: false,
  steps: [],
  screen: null,
  paper: null,
  outcome: null,
  prompt: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<RunSnapshot>): void {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

export function useDemoRun(): RunSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => snap,
  );
}

/** Close the overlay after a run has finished. */
export function dismissDemoRun(): void {
  if (!snap.active) set({ screen: null, paper: null, outcome: null });
}

let navigateFn: ((path: string) => void) | null = null;

/** The app registers its router here so the run can move between screens. */
export function registerNavigator(fn: ((path: string) => void) | null): void {
  navigateFn = fn;
}

let refreshFramesFn: (() => Promise<void>) | null = null;

/**
 * The evidence store's reload, so a photograph the run just saved appears on
 * the refused-attempts screen at once. That screen reloads its frames when the
 * chain event arrives, which can land before the browser has finished writing
 * the picture — so the run asks again once the write is done.
 */
export function registerFrameRefresh(fn: (() => Promise<void>) | null): void {
  refreshFramesFn = fn;
}

// ── asking the room ─────────────────────────────────────────────────────────
//
// The one moment in the run that nobody scripted: a judge types a key of their
// own choosing and the engine answers it. Their input, the real engine, a real
// photograph — the part of the demonstration that cannot have been rehearsed.

let promptResolve: ((v: string | null) => void) | null = null;

/** Called by the overlay with what was typed, or null for Skip. */
export function answerPrompt(value: string | null): void {
  const resolve = promptResolve;
  promptResolve = null;
  set({ prompt: null });
  resolve?.(value);
}

function askRoom(p: { question: string; hint: string }, ms = 120_000): Promise<string | null> {
  return new Promise((resolve) => {
    promptResolve = resolve;
    set({ prompt: p });
    window.setTimeout(() => {
      if (promptResolve === resolve) answerPrompt(null);
    }, ms);
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function startDemoRun(input: {
  pkg: PackageSummary;
  roster: RosterEntry[];
}): Promise<void> {
  if (snap.active) return;

  const P = input.pkg;
  const roster = input.roster;
  const sup = roster.find((r) => r.role === "superintendent");
  const obs = roster.find((r) => r.role === "observer");
  const setupHint = `node tools/demo-setup/index.mjs --centre ${P.centreId}`;

  const log: RunStep[] = [];
  set({
    active: true,
    steps: [],
    paper: null,
    outcome: null,
    prompt: null,
    screen: {
      title: "Starting the demonstration",
      caption: "Every step runs on the real ledger and access engine. Only the fingerprint reader is simulated.",
    },
  });
  const show = () => set({ steps: [...log] });

  /** Take the room to a screen, say what to look at, and hold there. */
  const go = async (path: string, title: string, caption: string, hold = 4500) => {
    set({ screen: { title, caption } });
    navigateFn?.(path);
    await pause(hold);
  };

  async function step<T>(
    label: string,
    fn: () => Promise<T>,
    describe?: (v: T) => string,
  ): Promise<T> {
    const i = log.push({ label, state: "running" }) - 1;
    show();
    set({ screen: { title: label, caption: "running…" } });
    try {
      const v = await fn();
      const detail = describe ? describe(v) : "";
      log[i] = { label, state: "done", ...(detail ? { detail } : {}) };
      show();
      set({ screen: { title: label, caption: detail || "done" } });
      await pause(900);
      return v;
    } catch (err) {
      const message = (err as Error).message;
      log[i] = { label, state: "failed", detail: message };
      show();
      set({ screen: { title: `Stopped at: ${label}`, caption: message } });
      throw err;
    }
  }

  const remedy = (reasons: string[], where?: { lat: number; lon: number }): string => {
    const fixes = new Set<string>();
    for (const r of reasons) {
      if (r === "outside_custody_window") fixes.add(`reopen the window: ${setupHint}`);
      else if (r === "outside_geofence")
        fixes.add(
          where
            ? `register the centre where you are: ${setupHint} --lat ${where.lat.toFixed(6)} --lon ${where.lon.toFixed(6)}`
            : "the laptop is outside the centre's 150 m geofence",
        );
      else if (r === "geo_missing" || r === "geo_accuracy_insufficient")
        fixes.add("allow location, or move nearer a window for a better fix");
      else if (r === "person_not_on_roster") fixes.add(`refresh the roster: ${setupHint}`);
      else if (r === "witness_frame_missing") fixes.add("allow the camera — the ceremony must be photographed");
      else if (r === "seam_token_absent") fixes.add("this package's flap code was printed elsewhere — use another package");
      else if (r === "package_compromised" || r === "package_already_opened")
        fixes.add("this package is closed for good — choose another");
      else if (r.startsWith("key_")) fixes.add("the custody key was refused — see the key step");
    }
    return fixes.size ? `Fix: ${[...fixes].join(" · ")}` : "";
  };

  const post = async (ev: SignedEvent): Promise<SignedEvent> => {
    const out = await sendSigned(ev);
    if (out.status === "rejected") {
      throw new Error(`ledger refused ${String(ev.body["kind"])}: ${out.code} — ${out.detail}`);
    }
    return { ...ev, seq: out.seq, ...(out.status === "appended" ? { hash: out.hash } : {}) };
  };

  // The run's own camera. An element that is never attached to the page still
  // plays a MediaStream and still hands frames to a canvas.
  const cam: { stream: MediaStream | null } = { stream: null };
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  const frameReady = async (ms = 4000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (video.videoWidth > 0 && video.readyState >= 2) return true;
      if (video.paused && video.srcObject) void video.play().catch(() => undefined);
      await pause(150);
    }
    return false;
  };

  const photo = async (fallback: string): Promise<string> =>
    cam.stream && (await frameReady())
      ? (await captureFrame(video)).sha256
      : digestOf(new TextEncoder().encode(fallback));

  try {
    // ── the package ──
    await go(
      `/workflow/${P.id}`,
      "Workflow",
      `This is the package the demonstration will seal, carry and open — ${P.centreCode}, seal ${P.sealSerial ?? "—"}.`,
      3500,
    );

    await step("Check the package can be opened", async () => {
      const now = Date.now();
      const problems: string[] = [];
      if (
        !P.custodyTo ||
        Date.parse(P.custodyTo) <= now ||
        (P.custodyFrom && Date.parse(P.custodyFrom) > now)
      ) {
        problems.push(`its custody window is closed — run: ${setupHint}`);
      }
      if (P.declaredState === "opened" || P.declaredState === "compromised") {
        problems.push(`it is ${P.declaredState} — choose another package`);
      }
      if (!sup || !obs) {
        problems.push(`no superintendent and observer on this centre's roster — run: ${setupHint}`);
      }
      if (problems.length) throw new Error(problems.join("; "));
    }, () => `${P.centreCode} · window open · ${sup?.displayName} and ${obs?.displayName} on the roster`);

    const S = sup!;
    const O = obs!;
    const serial = P.sealSerial ?? "SEAL-UNKNOWN";

    // ── camera and position — both are checks, so both are real ──
    await step("Turn on the camera for the witness photographs", async () => {
      cam.stream = await navigator.mediaDevices
        .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
        .catch((e: Error) => {
          throw new Error(
            e.name === "NotAllowedError"
              ? "the camera was not allowed — the engine refuses without a witness photograph"
              : e.message,
          );
        });
      video.srcObject = cam.stream;
      await video.play().catch(() => undefined);
      if (!(await frameReady(5000))) {
        throw new Error("the camera is on but has not produced a picture — close any other app using it and run again");
      }
    }, () => "camera on");

    const where = await step(
      "Take a position fix",
      () =>
        new Promise<{ lat: number; lon: number; accuracyM: number }>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            (p) =>
              resolve({
                lat: p.coords.latitude,
                lon: p.coords.longitude,
                accuracyM: Math.round(p.coords.accuracy),
              }),
            (e) => reject(new Error(`location was not allowed (${e.message}) — the engine refuses without a fix`)),
            { enableHighAccuracy: true, timeout: 10_000 },
          ),
        ),
      (f) => `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)} ±${f.accuracyM} m`,
    );

    // ── devices ──
    const id = await step(
      "Enrol the demo devices",
      () => ensureDemoIdentity(P.centreId),
      (v) => `station ${v.stationDeviceId.slice(0, 8)}… bound to ${P.centreCode}`,
    );
    await go(
      "/devices",
      "Devices",
      `The demo's station is enrolled and bound to ${P.centreCode} alone. A station from any other centre is refused.`,
    );

    // ── the paper and its seal ──
    const sealed = await step(
      "Encrypt the paper and split its key 3-of-4",
      () => sealDemoPaper(P.id),
      (s) => `${s.sealed.algorithm} · the key is split into 4 shares, any 3 rebuild it`,
    );
    await step(
      "Commit the seal to the chain",
      () => post(buildSealEvent(sealed, P.examId, P.centreId, id, P.copies, 4_500_000)),
      (e) => `PACKAGE_SEALED at #${e.seq ?? "?"}`,
    );

    // ── the journey ──
    await step("Carry it to the centre — three co-signed handovers", async () => {
      const officer = roster.find((r) => r.role === "district_officer") ?? S;
      const courier = roster.find((r) => r.role === "courier") ?? O;
      const custodian = roster.find((r) => r.role === "custodian") ?? O;
      const labels = [
        "Seal applied at the press",
        "Dispatched to the courier",
        "Received into overnight custody",
        "Delivered to the centre",
      ];
      const digests = new Map<string, string>();
      for (const label of labels) digests.set(label, await photo(`${P.id}:${label}`));
      const built = buildJourney(
        P.examId,
        P.centreId,
        P.id,
        serial,
        id,
        { districtOfficer: officer, courier, custodian, superintendent: S },
        (label) => ({ sha256: digests.get(label) ?? "" }),
      );
      const sent: JourneyHop[] = [];
      for (const hop of built) sent.push({ ...hop, event: await post(hop.event) });
      return sent;
    }, (s) => `${s.length} signed records, the last at #${s[s.length - 1]?.event.seq ?? "?"}`);
    await go(
      "/activity",
      "Activity",
      "The seal and the handovers just landed, newest first. Every handover is co-signed by two devices — one signature is refused.",
    );

    // ── the ceremony ──
    await step("Register the two officials' fingerprint slots", async () => {
      for (const [role, slot, person] of [
        ["superintendent", 1, S],
        ["observer", 11, O],
      ] as const) {
        await api
          .enrolFingerprint({
            deviceId: id.stationDeviceId,
            templateSlot: slot,
            personId: person.personId,
            role,
            fingerLabel: "demo — simulated reader",
          })
          .catch(() => undefined);
      }
    }, () => `slot 1 → ${S.displayName} (superintendent) · slot 11 → ${O.displayName} (observer)`);
    await go(
      "/slots",
      "Slots",
      `Slot 1 belongs to ${S.displayName}, slot 11 to ${O.displayName}. Only the slot number ever goes on the chain — no fingerprint image, no template.`,
    );

    await step("Two officials attest the opening", async () => {
      const plan = buildCeremony(P.examId, P.centreId, P.id, id, { superintendent: 1, observer: 11 });
      const sent: SignedEvent[] = [];
      for (const ev of plan.events) {
        sent.push(await post(ev));
        if (ev.body["kind"] === "WITNESS_ASSERTED") {
          if (!cam.stream || !(await frameReady())) {
            throw new Error("the camera stopped giving pictures, so the ceremony cannot be photographed — run again");
          }
          const shot = await captureFrame(video);
          sent.push(
            await post(
              buildFrameEvent(P.examId, P.centreId, P.id, id, plan.sessionId, String(ev.body["id"]), {
                sha256: shot.sha256,
                bytes: shot.blob.size,
                width: shot.width,
                height: shot.height,
              }),
            ),
          );
        }
      }
      return sent;
    }, (s) => `${S.displayName} and ${O.displayName} · ${s.length} signed records · reader simulated, photographs real`);
    await go(
      "/witness",
      "Ceremony",
      "Two fingerprints inside 120 seconds, each photographed as it was taken. In this demo the reader is simulated; the records and photographs are real.",
    );

    // ── the seam seal ──
    const seamHex = await step("Fit the seam seal across the flap", async () => {
      const slot = `mohar.demoSeam.${P.id}`;
      const detail = await api.package(P.id);
      if (detail.seamProtected) {
        const kept = readStore(slot);
        if (kept) return kept;
        throw new Error(
          "this package's flap code was printed from the Workflow page and this laptop never saw it — choose another package",
        );
      }
      const token = generateSeamToken();
      const hex = seamTokenToHex(token);
      await api.fitSeamSeal(P.id, seamCommitment(token, P.id));
      writeStore(slot, hex);
      return hex;
    }, (h) => `code ${h.slice(0, 8)}…${h.slice(-4)} · the server holds only its hash`);
    await go(
      `/workflow/${P.id}`,
      "Workflow",
      "A QR is now fitted across the flap — the server keeps only its hash. Everything this run did is in this timeline, in order.",
      5000,
    );

    // ── the key ──
    const key = await step("Issue the custody key for this six-hour window", async () => {
      const res = await api.issueKey(P.id, "unlock", S.personId);
      const slot = `mohar.demoKey.${P.id}.${res.key.epoch}`;
      if (res.key.revokedAt) {
        throw new Error("this window's key was revoked, and a revoked key blocks a new one until the next six-hour window");
      }
      if (res.key.key) {
        writeStore(slot, res.key.key);
        return res.key.key;
      }

      // The plaintext was handed out earlier this window, so the run has to be
      // given it. Anything it is given is checked against the fingerprint the
      // ledger holds before it is used or saved: an earlier run once saved a
      // mistyped key here and then presented it on every run after, and every
      // one of them failed at the last step for `key_unknown`.
      const expected = res.key.fingerprint;
      const fits = (k: string) => digestKey(k).fingerprint === expected;

      const kept = readStore(slot);
      if (kept && fits(kept)) return kept;
      if (kept) removeStore(slot);

      for (let tries = 0; tries < 3; tries++) {
        const typed = window
          .prompt(
            (tries ? "That is not this window's key — its fingerprint does not match.\n\n" : "") +
              "A custody key for this six-hour window was already issued, and the system shows it only once.\n\n" +
              `Its fingerprint is ${expected}. Paste that key here:`,
          )
          ?.trim();
        if (!typed) break;
        if (fits(typed)) {
          writeStore(slot, typed);
          return typed;
        }
      }
      throw new Error(
        `no key matching fingerprint ${expected} was given — paste the key issued for this window, or wait for the next window`,
      );
    }, (k) => `${k} — fingerprint ${digestKey(k).fingerprint} — valid until this six-hour window closes`);
    await go(
      "/keys",
      "Keys",
      "The custody key for this six-hour window. It expires by arithmetic — nothing has to remember to rotate it.",
    );

    // ── three requests, three answers from the engine ──
    const ask = (over: { presentedKey: string; seamTokenRead?: string }) =>
      api.requestAccess({
        packageId: P.id,
        stage: "unlock",
        deviceId: id.stationDeviceId,
        personId: S.personId,
        sealSerialRead: serial,
        geo: where,
        ...over,
      });
    const said = (d: AccessDecisionResult) =>
      `${d.outcome.toUpperCase()} — ${d.denyReasons.join(", ") || `${d.checksPassed.length} of ${d.checks.length} checks passed`}`;

    // ── the judge's own attempt ──
    // Taken to the refused-attempts screen first, so the room watches their own
    // attempt and their own photograph arrive there.
    await go(
      "/failed",
      "Your turn",
      "Judge, please type any key you like in the box below and try to open this package.",
      800,
    );
    const typed = (
      await askRoom({
        question: "Type any custody key and try to open the package",
        hint: "anything at all — e.g. MHR-UNLOCK-1234 — then press Enter",
      })
    )?.slice(0, 120);

    const attempt = await step(
      typed ? `The judge tries a key: “${typed}”` : "Nothing typed — a wrong key is tried instead",
      () => ask({ presentedKey: typed || "MHR-UNLOCK-WRONG-KEY-FOR-DEMO", seamTokenRead: seamHex }),
      (d) =>
        d.outcome === "granted"
          ? "GRANTED — that was the real custody key for this window"
          : said(d),
    );

    if (attempt.outcome === "denied") {
      await step("Photograph whoever typed it", async () => {
        if (!cam.stream || !(await frameReady())) return null;
        const shot = await captureFrame(video);
        const ev = await post(
          buildAccessFrameEvent(P.examId, P.centreId, P.id, id, attempt.attemptId, {
            sha256: shot.sha256,
            bytes: shot.blob.size,
            width: shot.width,
            height: shot.height,
          }),
        );
        // Kept in this browser so the refused-attempts screen can show the
        // picture itself; the chain holds only its digest.
        await putFrame({
          id: String(ev.body["id"]),
          kind: "refusal",
          boundEventId: attempt.attemptId,
          sessionId: attempt.sessionId,
          packageId: P.id,
          sha256: shot.sha256,
          seq: ev.seq ?? "",
          capturedAt: String(ev.body["occurredAt"]),
          width: shot.width,
          height: shot.height,
          bytes: shot.blob.size,
          blob: shot.blob,
          reasons: attempt.denyReasons,
        });
        await refreshFramesFn?.();
        return ev;
      }, (ev) =>
        ev
          ? `photograph committed at #${ev.seq ?? "?"} — the chain holds only its hash`
          : "the camera gave no picture — the refusal is recorded without one",
      );
      await pause(3500);
    }

    await step("Right key, but the flap was torn — its code cannot be read", async () => {
      const d = await ask({ presentedKey: key });
      if (d.outcome !== "denied") throw new Error("an unreadable seam was granted — stop, this is a defect");
      return d;
    }, said);
    await go(
      "/failed",
      "Failed attempts",
      "Both refused and both recorded — the judge's key with their photograph, and the torn flap. A refusal is evidence, not an error.",
      5500,
    );

    const granted = await step("The real officials, with everything in order", async () => {
      const d = await ask({ presentedKey: key, seamTokenRead: seamHex });
      if (d.outcome !== "granted") {
        throw new Error(`REFUSED — ${d.denyReasons.join(", ")}. ${remedy(d.denyReasons, where)}`);
      }
      return d;
    }, said);
    await go(
      "/activity",
      "Activity",
      `ACCESS GRANTED — ${granted.checksPassed.length} of ${granted.checks.length} checks passed. The ones with no sensor fitted say "not evaluated" instead of passing.`,
      5500,
    );

    // ── the threshold, then the paper ──
    await step("Two key shares are not enough", async () => {
      const a = await tryRecover(shareSubset(sealed.split, 2), sealed.split.secretCommitment);
      if (a.ok) throw new Error("two shares rebuilt the key — the threshold is broken");
      return a;
    }, () => "refused — the threshold is three");

    const paper = await step("Three shares rebuild the key and the paper opens", async () => {
      const a = await tryRecover(shareSubset(sealed.split, 3), sealed.split.secretCommitment);
      if (!a.ok || !a.key) throw new Error(a.detail);
      return openDemoPaper(sealed, a.key);
    }, () => "key rebuilt · paper decrypted");

    await go(
      "/integrity",
      "Integrity",
      "Every record from this run is chained to the one before it. Alter any one and every record after it breaks.",
      5500,
    );

    navigateFn?.("/demo");
    set({
      paper,
      outcome: "ok",
      screen: {
        title: "The paper is open",
        caption: "It opened only after every record you just saw existed, and every check had passed.",
      },
    });
  } catch {
    set({ outcome: "failed" });
  } finally {
    cam.stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    if (promptResolve) answerPrompt(null);
    set({ active: false, prompt: null });
  }
}
