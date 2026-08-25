import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AccessDecisionResult, type PackageSummary, type RosterEntry } from "../lib/api";
import { useAsync, formatTime } from "../lib/hooks";
import { Card, ErrorNote } from "../components/ui";
import { captureFrame } from "../lib/witness";
import {
  DEMO_PAPER,
  buildCeremony,
  buildFrameEvent,
  buildSealEvent,
  ensureDemoIdentity,
  openDemoPaper,
  sealDemoPaper,
  sendSigned,
  shareSubset,
  tryRecover,
  type DemoIdentity,
  type RecoveryAttempt,
  type SealedPackage,
  type SignedEvent,
} from "../lib/liveDemo";

/**
 * ── The whole system, in one screen and about three minutes ──────────────────
 *
 * A paper is sealed, its key is split, the seal is committed to the chain, a
 * ceremony is attested, the access engine is asked, and — only if it says yes —
 * three shares rebuild the key and the paper opens.
 *
 * Nothing on this page is a mock. The ciphertext is produced by the same AEAD
 * the rest of the system uses; the shares come from the same audited Shamir
 * implementation; the events are signed with real Ed25519 over real RFC 8785
 * canonical bytes and are rejected by the real ledger if they are malformed; and
 * the twenty-one checks are whatever the real engine returned, pass or fail.
 *
 * One thing is fabricated, and it is fabricated in the open: with no fingerprint
 * reader on the desk there is no finger to read, so the witness assertions are
 * signed by a station device the demo enrolled. The events are genuine; the
 * hardware input behind them is not, and every panel that shows them says so.
 * If the engine refuses, this page shows the refusal rather than pretending —
 * a demonstration that can only succeed is not demonstrating anything.
 */

type StepState = "idle" | "running" | "done" | "failed";

interface Step {
  key: string;
  title: string;
  state: StepState;
  detail?: string;
}

const short = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Wrap long hex so a 900-character ciphertext does not blow the layout apart. */
const wrapHex = (hex: string, per = 64): string[] => {
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += per) out.push(hex.slice(i, i + per));
  return out;
};

export default function LiveDemo() {
  const { data: pkgData, error: pkgError } = useAsync(() => api.packages(), []);
  const [packageId, setPackageId] = useState("");

  const pkg: PackageSummary | undefined = useMemo(
    () => pkgData?.packages.find((p) => p.id === packageId),
    [pkgData, packageId],
  );

  /**
   * Default to a package whose custody window is actually open.
   *
   * The seeded packages all have closed windows on purpose, and picking one
   * produces a refusal for `outside_custody_window` that reads as the demo being
   * broken. Preferring an open one puts the operator on the path where the
   * refusals they see are the ones they meant to cause.
   */
  useEffect(() => {
    if (packageId || !pkgData?.packages?.length) return;
    const now = Date.now();
    const open = pkgData.packages.filter(
      (p) => p.custodyTo && Date.parse(p.custodyTo) > now && p.declaredState === "at_centre",
    );
    const pick = open.at(-1) ?? pkgData.packages.at(-1);
    if (pick) setPackageId(pick.id);
  }, [pkgData, packageId]);

  const { data: rosterData } = useAsync(
    () => (pkg ? api.roster(pkg.centreId) : Promise.resolve({ roster: [] as RosterEntry[] })),
    [pkg?.centreId],
  );
  const roster = rosterData?.roster ?? [];
  const superintendent = roster.find((r) => r.role === "superintendent");
  const observer = roster.find((r) => r.role === "observer");

  const [identity, setIdentity] = useState<DemoIdentity | null>(null);
  const [sealedPkg, setSealedPkg] = useState<SealedPackage | null>(null);
  const [sealEvent, setSealEvent] = useState<SignedEvent | null>(null);
  const [ceremonyEvents, setCeremonyEvents] = useState<SignedEvent[]>([]);
  const [recovery, setRecovery] = useState<RecoveryAttempt | null>(null);
  const [decision, setDecision] = useState<AccessDecisionResult | null>(null);
  const [deniedDemo, setDeniedDemo] = useState<AccessDecisionResult | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [chain, setChain] = useState<{ seq: string; kind: string; prev: string; hash: string }[]>([]);

  const [sealSerial, setSealSerial] = useState("");
  const [custodyKey, setCustodyKey] = useState("");
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracyM: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showCipher, setShowCipher] = useState(false);

  /** Held back until the ledger has answered. Nothing is sent while offline. */
  const [offline, setOffline] = useState(false);
  const [spool, setSpool] = useState<SignedEvent[]>([]);

  useEffect(() => {
    if (pkg?.sealSerial) setSealSerial(pkg.sealSerial);
  }, [pkg?.sealSerial]);

  /**
   * The camera is what makes `witness_capture` passable here.
   *
   * That check accepts a frame from the station or from the centre PC, and with
   * no camera on the ESP32 the centre PC is the only one there is. Without it the
   * engine refuses — correctly — so the demo either photographs the ceremony for
   * real or shows the refusal that follows from not having.
   */
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (err) {
      const e = err as Error;
      setCameraError(
        e.name === "NotAllowedError"
          ? "Camera permission was refused. Browsers only offer it on localhost or over https."
          : e.message,
      );
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const steps: Step[] = [
    { key: "paper", title: "Demo paper prepared", state: "done" },
    { key: "encrypt", title: "Content encrypted", state: sealedPkg ? "done" : "idle" },
    { key: "split", title: "Key split 3-of-4", state: sealedPkg ? "done" : "idle" },
    { key: "seal", title: "Seal committed to chain", state: sealEvent?.seq ? "done" : "idle" },
    {
      key: "ceremony",
      title: "Ceremony attested",
      state: ceremonyEvents.some((e) => e.seq) ? "done" : "idle",
    },
    {
      key: "decide",
      title: "Access engine asked",
      state: decision ? (decision.outcome === "granted" ? "done" : "failed") : "idle",
    },
    { key: "recover", title: "Key reconstructed", state: recovery?.ok ? "done" : "idle" },
    { key: "open", title: "Paper decrypted", state: plaintext ? "done" : "idle" },
  ];

  // ── the queue that offline mode diverts into ──────────────────────────────

  /**
   * Send, unless the demo is pretending the network is gone.
   *
   * The record is already built and signed by the time it arrives here, so going
   * offline delays delivery and nothing else. On restore the same event — same
   * id — is sent again, which is what makes the ledger's duplicate handling the
   * thing being demonstrated rather than a fresh event standing in for it.
   */
  const deliver = useCallback(
    async (ev: SignedEvent): Promise<SignedEvent> => {
      if (offline) {
        setSpool((s) => [...s, ev]);
        return ev;
      }
      const out = await sendSigned(ev);
      if (out.status === "rejected") {
        throw new Error(`ledger refused ${String(ev.body["kind"])}: ${out.code} — ${out.detail}`);
      }
      return { ...ev, seq: out.seq, ...(out.status === "appended" ? { hash: out.hash } : {}) };
    },
    [offline],
  );

  const flushSpool = async () => {
    setBusy("draining the spool");
    setError(null);
    try {
      const drained: SignedEvent[] = [];
      for (const ev of spool) {
        const out = await sendSigned(ev);
        if (out.status === "rejected") {
          throw new Error(`ledger refused a spooled record: ${out.code}`);
        }
        drained.push({ ...ev, seq: out.seq, ...(out.status === "appended" ? { hash: out.hash } : {}) });
      }
      // Reattach sequences to whichever record each spooled event belonged to.
      setSealEvent((s) => drained.find((d) => d.body["id"] === s?.body["id"]) ?? s);
      setCeremonyEvents((prev) =>
        prev.map((p) => drained.find((d) => d.body["id"] === p.body["id"]) ?? p),
      );
      setSpool([]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  // ── stage actions ─────────────────────────────────────────────────────────

  const doEncrypt = async () => {
    if (!packageId) return;
    setBusy("encrypting the paper");
    setError(null);
    try {
      setSealedPkg(await sealDemoPaper(packageId));
      setPlaintext(null);
      setRecovery(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  const doSeal = async () => {
    if (!sealedPkg || !pkg) return;
    setBusy("committing the seal");
    setError(null);
    try {
      const id = await ensureDemoIdentity(pkg.centreId);
      setIdentity(id);
      const ev = buildSealEvent(sealedPkg, pkg.examId, pkg.centreId, id, pkg.copies, 4_500_000);
      setSealEvent(await deliver(ev));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Register a slot per official, then attest the ceremony as the station.
   *
   * The slot registration is reference data, not chain data — it is how "slot 3
   * matched" becomes "R. Verma", and the engine reads it to answer roster
   * membership. Re-registering an existing slot is refused by the ledger's
   * unique index, which is harmless here and is caught rather than surfaced.
   */
  const doCeremony = async () => {
    if (!pkg || !superintendent || !observer) return;
    setBusy("attesting the ceremony");
    setError(null);
    try {
      const id = identity ?? (await ensureDemoIdentity(pkg.centreId));
      setIdentity(id);

      const slots = { superintendent: 1, observer: 11 };
      for (const [role, slot, person] of [
        ["superintendent", slots.superintendent, superintendent],
        ["observer", slots.observer, observer],
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

      const plan = buildCeremony(pkg.examId, pkg.centreId, pkg.id, id, slots);
      const sent: SignedEvent[] = [];
      for (const ev of plan.events) {
        const posted = await deliver(ev);
        sent.push(posted);

        // Photograph each assertion as it lands, exactly as the Ceremony page
        // does. Only the digest is committed; the image is not sent anywhere.
        if (ev.body["kind"] === "WITNESS_ASSERTED" && cameraOn && videoRef.current) {
          const shot = await captureFrame(videoRef.current);
          sent.push(
            await deliver(
              buildFrameEvent(pkg.examId, pkg.centreId, pkg.id, id, plan.sessionId, String(ev.body["id"]), {
                sha256: shot.sha256,
                bytes: shot.blob.size,
                width: shot.width,
                height: shot.height,
              }),
            ),
          );
        }
      }
      setCeremonyEvents(sent);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  const locate = () => {
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (p) =>
        setFix({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracyM: Math.round(p.coords.accuracy),
        }),
      (e) => setError(new Error(`could not get a position fix: ${e.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  /** Ask the real engine. `presentedKey` is whatever was typed — including nothing. */
  const askEngine = async (key: string, into: (d: AccessDecisionResult) => void) => {
    if (!pkg || !identity) return;
    setBusy("asking the access engine");
    setError(null);
    try {
      const result = await api.requestAccess({
        packageId: pkg.id,
        stage: "unlock",
        deviceId: identity.stationDeviceId,
        ...(superintendent ? { personId: superintendent.personId } : {}),
        ...(key ? { presentedKey: key } : {}),
        ...(sealSerial.trim() ? { sealSerialRead: sealSerial.trim() } : {}),
        ...(fix ? { geo: fix } : {}),
      });
      into(result);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  const doRecoverAndOpen = async (count: number) => {
    if (!sealedPkg) return;
    setBusy(`combining ${count} shares`);
    setError(null);
    try {
      const attempt = await tryRecover(
        shareSubset(sealedPkg.split, count),
        sealedPkg.split.secretCommitment,
      );
      setRecovery(attempt);
      if (attempt.ok && attempt.key && decision?.outcome === "granted") {
        setPlaintext(openDemoPaper(sealedPkg, attempt.key));
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  const loadChain = async () => {
    setBusy("reading the chain");
    setError(null);
    try {
      const health = await api.health();
      const tip = Number(health.chainTip?.seq ?? 0);
      const { events } = await api.rawEvents(String(Math.max(0, tip - 4)), 10);
      setChain(
        events.slice(-3).map((e) => ({
          seq: String(e.seq),
          kind: e.kind,
          prev: (e as unknown as { prev_hash: string }).prev_hash,
          hash: (e as unknown as { hash: string }).hash,
        })),
      );
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  if (pkgError) return <ErrorNote error={pkgError} />;

  const granted = decision?.outcome === "granted";

  return (
    <div className="ld">
      <div className="note">
        <strong>Everything on this page is real except one thing.</strong> The encryption, the
        key split, the signatures, the chain and the twenty-one checks are the system's own
        implementations, and the ledger refuses anything malformed. What is simulated is the
        <em> fingerprint reader</em>: with no R307 on the desk, the witness assertions are
        signed by a station device this page enrolled. The events are genuine; the hardware
        input behind them is not, and it is labelled wherever it appears.
      </div>

      {error && <ErrorNote error={error} />}

      {/* ── progress ─────────────────────────────────────────────────────── */}
      <div className="ld-track">
        {steps.map((s, i) => (
          <div key={s.key} className={`ld-step ${s.state}`}>
            <span className="ld-step-n">{i + 1}</span>
            <span className="ld-step-t">{s.title}</span>
          </div>
        ))}
      </div>

      {/* ── setup ────────────────────────────────────────────────────────── */}
      <Card title="Package" hint="which package this demonstration seals and opens">
        <div className="ld-row">
          <select
            className="wit-select"
            value={packageId}
            onChange={(e) => {
              setPackageId(e.target.value);
              setSealedPkg(null);
              setSealEvent(null);
              setCeremonyEvents([]);
              setDecision(null);
              setPlaintext(null);
              setRecovery(null);
            }}
          >
            <option value="">— choose a package —</option>
            {pkgData?.packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.centreCode} · {p.sealSerial} · {p.declaredState}
              </option>
            ))}
          </select>
          <label className="ld-offline">
            <input
              type="checkbox"
              checked={offline}
              onChange={(e) => setOffline(e.target.checked)}
            />
            Simulate network offline
            {spool.length > 0 && <span className="ld-spool">{spool.length} spooled</span>}
          </label>
          {spool.length > 0 && !offline && (
            <button className="wit-btn" onClick={() => void flushSpool()} disabled={!!busy}>
              Restore network — drain spool
            </button>
          )}
        </div>
        {pkg && (
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Centre</dt>
            <dd>{pkg.centreCode}</dd>
            <dt>Custody window</dt>
            <dd>
              {pkg.custodyTo
                ? `${formatTime(pkg.custodyTo)}${
                    Date.parse(pkg.custodyTo) < Date.now() ? " — closed" : " — open"
                  }`
                : "none configured"}
            </dd>
            <dt>On the roster</dt>
            <dd>
              {roster.length === 0
                ? "nobody is posted here — the engine will refuse for person_not_on_roster"
                : roster.map((r) => `${r.displayName} (${r.role})`).join(", ")}
            </dd>
          </dl>
        )}
        {offline && (
          <div className="ld-banner offline">
            Network offline. Records are still built and signed at the moment they happen —
            they queue here and are delivered unchanged when the network returns.
          </div>
        )}
      </Card>

      {/* ── 1. the paper ─────────────────────────────────────────────────── */}
      <Card
        title="1 · The paper, before encryption"
        hint="visible here only because this is the authorised preparation stage"
      >
        <pre className="ld-paper">{DEMO_PAPER}</pre>
      </Card>

      {/* ── 2. encryption ────────────────────────────────────────────────── */}
      <Card title="2 · Encryption" hint="XChaCha20-Poly1305, bound to this package id">
        <button className="wit-btn" onClick={() => void doEncrypt()} disabled={!packageId || !!busy}>
          {sealedPkg ? "Encrypt again" : "Encrypt the paper"}
        </button>

        {sealedPkg && (
          <>
            <div className="ld-flow">
              <span>Original paper</span>
              <span className="ld-arrow">↓</span>
              <span>{sealedPkg.sealed.algorithm}</span>
              <span className="ld-arrow">↓</span>
              <span className="ok">Encrypted package created</span>
            </div>
            <dl className="kv">
              <dt>Package</dt>
              <dd className="mono">{sealedPkg.packageId}</dd>
              <dt>Algorithm</dt>
              <dd className="mono">{sealedPkg.sealed.algorithm}</dd>
              <dt>Nonce</dt>
              <dd className="mono">{sealedPkg.sealed.nonceHex}</dd>
              <dt>Content hash</dt>
              <dd className="mono ld-hash">{sealedPkg.sealed.contentSha256}</dd>
              <dt>Ciphertext hash</dt>
              <dd className="mono ld-hash">{sealedPkg.sealed.ciphertextSha256}</dd>
              <dt>Size</dt>
              <dd>
                {sealedPkg.sealed.plaintextBytes} bytes plaintext →{" "}
                {sealedPkg.sealed.ciphertextBytes} bytes ciphertext (16-byte Poly1305 tag)
              </dd>
            </dl>
            <button className="wit-btn ghost" onClick={() => setShowCipher((v) => !v)}>
              {showCipher ? "Hide ciphertext" : "Show actual ciphertext"}
            </button>
            {showCipher && (
              <pre className="ld-cipher">
                {wrapHex(sealedPkg.sealed.ciphertextHex).join("\n")}
              </pre>
            )}
          </>
        )}
      </Card>

      {/* ── 3. the split ─────────────────────────────────────────────────── */}
      {sealedPkg && (
        <Card title="3 · Key split, 3 of 4" hint="Shamir over GF(2⁸) — audited implementation">
          <div className="ld-shares">
            {sealedPkg.split.shares.map((s) => (
              <div key={s.index} className="ld-share">
                <div className="ld-share-h">
                  Share {s.index} · {s.holder}
                </div>
                <div className="mono ld-share-c">{short(s.commitment, 24)}</div>
                <div className="ld-share-f">{s.share.length} bytes · commitment sha256</div>
              </div>
            ))}
          </div>

          <div className="ld-row">
            <button className="wit-btn ghost" onClick={() => void doRecoverAndOpen(2)} disabled={!!busy}>
              Try with 2 shares
            </button>
            <button className="wit-btn" onClick={() => void doRecoverAndOpen(3)} disabled={!!busy}>
              Try with 3 shares
            </button>
          </div>

          {recovery && (
            <div className={`ld-banner ${recovery.ok ? "ok" : "bad"}`}>
              <strong>{recovery.used} shares — {recovery.ok ? "key recovered" : "insufficient"}</strong>
              <div>{recovery.detail}</div>
              {recovery.ok && !granted && (
                <div className="ld-gate">
                  The key is rebuilt, but the paper stays sealed: nothing is decrypted on this
                  page until the access engine has granted. Run the ceremony and ask the engine
                  below.
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ── 4. seal into the chain ───────────────────────────────────────── */}
      {sealedPkg && (
        <Card title="4 · Commit the seal" hint="PACKAGE_SEALED — the digest, not the ciphertext">
          <button className="wit-btn" onClick={() => void doSeal()} disabled={!!busy}>
            Sign and append PACKAGE_SEALED
          </button>
          {sealEvent && (
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Event id</dt>
              <dd className="mono">{String(sealEvent.body["id"])}</dd>
              <dt>Signature</dt>
              <dd className="mono ld-hash">{sealEvent.deviceSig}</dd>
              <dt>Chain</dt>
              <dd className="mono">
                {sealEvent.seq ? `seq ${sealEvent.seq}` : "spooled — not yet delivered"}
              </dd>
              {sealEvent.hash && (
                <>
                  <dt>Chain hash</dt>
                  <dd className="mono ld-hash">{sealEvent.hash}</dd>
                </>
              )}
            </dl>
          )}
        </Card>
      )}

      {/* ── 5. ceremony ──────────────────────────────────────────────────── */}
      {sealEvent && (
        <Card
          title="5 · Unlock ceremony"
          hint="two officials, distinct slots, inside a 120-second window"
        >
          <div className="ld-sim">
            DEMO · SIMULATED HARDWARE INPUT — no fingerprint reader is attached, so the match
            scores and slots below are fabricated. The assertions themselves are really signed
            by an enrolled station device and really evaluated by the engine.
          </div>
          <div className="ld-cam">
            <video ref={videoRef} className="ld-video" playsInline muted />
            {!cameraOn && <div className="ld-video-off">camera off</div>}
          </div>
          <div className="ld-row">
            <button className="wit-btn ghost" onClick={() => (cameraOn ? stopCamera() : void startCamera())}>
              {cameraOn ? "Stop camera" : "Start camera"}
            </button>
            <button
              className="wit-btn"
              onClick={() => void doCeremony()}
              disabled={!!busy || !superintendent || !observer}
            >
              Start unlock ceremony
            </button>
          </div>
          {cameraError && <div className="wit-error">{cameraError}</div>}
          {!cameraOn && (
            <div className="wit-note">
              With the camera off no photograph is committed, and the engine refuses for
              <code> witness_capture</code> — a ceremony nobody photographed has no evidence of
              who was standing there. Start the camera to see the granted path.
            </div>
          )}
          {!superintendent || !observer ? (
            <div className="wit-note">
              This centre has no superintendent and observer on its roster, so a two-person
              ceremony cannot be attested against it. Pick a package created by
              <code> tools/demo-setup</code>.
            </div>
          ) : null}

          {ceremonyEvents.length > 0 && (
            <table className="slot-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Kind</th>
                  <th>Seq</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {ceremonyEvents.map((e) => (
                  <tr key={String(e.body["id"])}>
                    <td className="mono">{String(e.body["id"]).slice(0, 8)}…</td>
                    <td className="mono">{String(e.body["kind"])}</td>
                    <td className="mono">{e.seq ?? "spooled"}</td>
                    <td className="mono">{short(e.deviceSig, 20)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* ── 6. the engine ────────────────────────────────────────────────── */}
      {ceremonyEvents.length > 0 && (
        <Card title="6 · The twenty-one checks" hint="deny by default; every check evaluated">
          <div className="ld-form">
            <label>
              <span>Seal serial</span>
              <input
                className="wit-select"
                value={sealSerial}
                onChange={(e) => setSealSerial(e.target.value)}
                placeholder="SEAL-…"
              />
            </label>
            <label>
              <span>Custody key</span>
              <input
                className="wit-select"
                value={custodyKey}
                onChange={(e) => setCustodyKey(e.target.value)}
                placeholder="MHR-UNLOCK-…"
              />
            </label>
          </div>
          <div className="ld-row">
            <button className="wit-btn ghost" onClick={locate} disabled={!!busy}>
              {fix ? `Located · ±${fix.accuracyM} m` : "Locate"}
            </button>
            <button
              className="wit-btn"
              onClick={() => void askEngine(custodyKey.trim(), setDecision)}
              disabled={!!busy}
            >
              Request unlock decision
            </button>
            <button
              className="wit-btn ghost"
              onClick={() => void askEngine("MHR-UNLOCK-WRONG-KEY-FOR-DEMO", setDeniedDemo)}
              disabled={!!busy}
              title="Submits a deliberately wrong key. The refusal is real and is recorded."
            >
              Demonstrate a failed attempt
            </button>
          </div>
          {!fix && (
            <div className="wit-note">
              No position fix yet. The engine refuses for <code>geo_missing</code> until you
              locate — the geofence check exists to prove this device is at the centre.
            </div>
          )}

          {[decision, deniedDemo].filter(Boolean).map((d, i) => (
            <div key={i} className="ld-decision">
              <div className={`verdict ${d!.outcome === "granted" ? "granted" : "denied"}`}>
                {d!.outcome === "granted" ? "ACCESS GRANTED" : "ACCESS DENIED"}
                <span style={{ opacity: 0.75, fontWeight: 400, marginLeft: 8 }}>
                  {d!.checksPassed.length}/{d!.checks.length} checks passed
                  {d === deniedDemo && " · deliberately wrong key"}
                </span>
              </div>
              <div className="ld-checks">
                {d!.checks.map((c) => (
                  <div key={c.check} className={`check ${c.passed ? "pass" : "fail"}`}>
                    <span className="check-name mono">{c.check}</span>
                    <span className="check-evidence">{c.evidence}</span>
                  </div>
                ))}
              </div>
              {d === deniedDemo && (
                <div className="wit-note">
                  This refusal was written to the chain before the answer was returned, and it
                  now appears on the <strong>Failed Attempts</strong> page — with a photograph
                  if the camera on that page is armed.
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* ── 7. open it ───────────────────────────────────────────────────── */}
      {granted && (
        <Card title="7 · Reconstruct and decrypt" hint="only reachable once the engine has granted">
          <div className="ld-flow">
            <span>Encrypted package</span>
            <span className="ld-arrow">↓</span>
            <span>3 of 4 shares</span>
            <span className="ld-arrow">↓</span>
            <span>Content key</span>
            <span className="ld-arrow">↓</span>
            <span className="ok">Original paper</span>
          </div>
          <button className="wit-btn" onClick={() => void doRecoverAndOpen(3)} disabled={!!busy}>
            Reconstruct key and decrypt
          </button>
          {plaintext && (
            <>
              <div className="ld-banner ok">
                Decrypted, and the plaintext hashes to the digest recorded at sealing —
                so this is the document that was sealed, not merely a document that opened.
              </div>
              <pre className="ld-paper opened">{plaintext}</pre>
            </>
          )}
        </Card>
      )}

      {/* ── 8. chain proof ───────────────────────────────────────────────── */}
      <Card title="8 · The chain" hint="each record carries the hash of the one before it">
        <button className="wit-btn ghost" onClick={() => void loadChain()} disabled={!!busy}>
          Show the last three records
        </button>
        {chain.length > 0 && (
          <div className="ld-chain">
            {chain.map((c, i) => (
              <div key={c.seq} className="ld-link">
                <div className="ld-link-h">
                  Event {c.seq} · <span className="mono">{c.kind}</span>
                </div>
                <div className="ld-link-r">
                  <span className="ld-lbl">prev</span>
                  <span className="mono ld-hash">{c.prev}</span>
                </div>
                <div className="ld-link-r">
                  <span className="ld-lbl">hash</span>
                  <span className="mono ld-hash strong">{c.hash}</span>
                </div>
                {i < chain.length - 1 && (
                  <div className="ld-link-join">
                    ↓ this hash is the next record&apos;s <em>prev</em>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {busy && <div className="ld-busy">{busy}…</div>}
    </div>
  );
}
