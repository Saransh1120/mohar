import { requestSigningBytes, REQUEST_SIGNATURE_HEADERS } from "@mohar/crypto-core";
import { applyLanguage, languageButton, t } from "./i18n";
import "./style.css";

/**
 * ── The officer's end of a damaged-label video call ──────────────────────────
 *
 * A separate page (`/field/call.html`) so that it shares nothing with the scan
 * and hand-off screens but the phone's enrolled key, which it reads from the
 * same store and never writes.
 *
 * The officer picks one of this phone's own override requests and opens the
 * camera. Each control room operator who opens the call from their side is
 * offered this camera directly, browser to browser. The ledger carries the two
 * set-up messages and records what each end reports; it never sees the picture
 * and nothing of the picture is kept, here or there.
 *
 * Every request is signed with this phone's key, like a hand-off step. Only the
 * phone that made a request can be the phone on its call.
 *
 * The same call logic exists in the control room (lib/overrideCall.ts), for a
 * console standing in for a handheld. It is repeated here rather than shared
 * because the two apps share no browser package.
 */

interface Identity { deviceId: string; examId: string; centreId: string; personId: string; }
interface Signal { seq: number; kind: "operator-joined" | "device-joined" | "offer" | "answer" | "bye"; from: string; fromName?: string; sdp?: string; }
interface OwnRequest { id: string; leg_no: number; from_place: string; to_place: string; seal_serial: string | null; requested_at: string; approvals: number; refused: boolean; }
interface Peer { pc: RTCPeerConnection; name: string; connectedAt: number; lastReport: number; }

const DB = "mohar-field-v1";
const POLL_MS = 1500;
const GATHER_MS = 4000;
const REPORT_MS = 60_000;

function setting<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    // A phone that was never enrolled has no store; say so rather than make one.
    open.onupgradeneeded = () => { open.transaction?.abort(); };
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction("settings", "readonly").objectStore("settings").get(key);
      req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  });
}

const hex = (b: ArrayBufferLike) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join("");

let identity: Identity | undefined;
let key: CryptoKey | undefined;

async function signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!identity || !key) throw new Error(t("c_not_enrolled"));
  const json = JSON.stringify({ ...body, deviceId: identity.deviceId });
  const timestamp = new Date().toISOString();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const signed = requestSigningBytes({ method: "POST", path, timestamp, nonce, body: new TextEncoder().encode(json) });
  const signature = hex(await crypto.subtle.sign("Ed25519", key, Uint8Array.from(signed)));
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REQUEST_SIGNATURE_HEADERS.device]: identity.deviceId,
      [REQUEST_SIGNATURE_HEADERS.timestamp]: timestamp,
      [REQUEST_SIGNATURE_HEADERS.nonce]: nonce,
      [REQUEST_SIGNATURE_HEADERS.signature]: signature,
    },
    body: json,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${path} returned ${res.status}`);
  return data;
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<header><strong>Mohar Field</strong><span><a href="/field/" style="color:inherit" data-i18n="c_back"></a> <span id="lang"></span></span></header>
<section><h1 data-i18n="c_h"></h1>
<p data-i18n="c_p1"></p>
<p data-i18n="c_p2"></p>
<p id="device"></p>
<label><span data-i18n="c_request"></span><select id="request"></select></label>
<button id="open" data-i18n="c_open"></button>
<button id="close" data-i18n="c_close" hidden></button>
<p id="status" role="status"></p>
<video id="preview" autoplay playsinline muted style="width:100%;border-radius:8px;background:#000" hidden></video>
</section>`;

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const say = (message: string) => { el("status").textContent = message; };

const peers = new Map<string, Peer>();
let camera: MediaStream | null = null;
let iceServers: RTCIceServer[] = [];
let overrideId = "";
let after = 0;
let poll: ReturnType<typeof setInterval> | null = null;

function describe(): void {
  const live = [...peers.values()].filter((p) => p.pc.connectionState === "connected");
  say(
    live.length > 0
      ? t("c_live", { names: live.map((p) => p.name).join(t("c_and")) })
      : peers.size > 0
        ? t("c_calling")
        : t("c_waiting"),
  );
}

/** The local description once every candidate is in it, or after a few seconds. */
async function gathered(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const done = () => { pc.removeEventListener("icegatheringstatechange", check); clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error(t("c_no_sdp"));
  return sdp;
}

async function handle(s: Signal): Promise<void> {
  if (s.kind === "operator-joined") {
    peers.get(s.from)?.pc.close();
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = { pc, name: s.fromName ?? t("c_an_operator"), connectedAt: 0, lastReport: 0 };
    peers.set(s.from, peer);
    for (const track of camera?.getTracks() ?? []) pc.addTrack(track, camera!);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") peer.connectedAt = Date.now();
      if (pc.connectionState === "failed") {
        say(t("c_failed"));
      } else describe();
    };
    await pc.setLocalDescription(await pc.createOffer());
    await signedPost(`/overrides/${overrideId}/call/device/offer`, { to: s.from, sdp: await gathered(pc) });
    describe();
  } else if (s.kind === "answer" && s.sdp) {
    const peer = peers.get(s.from);
    if (peer && peer.pc.signalingState === "have-local-offer") await peer.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
  } else if (s.kind === "bye") {
    peers.get(s.from)?.pc.close();
    peers.delete(s.from);
    describe();
  }
}

async function tick(): Promise<void> {
  try {
    const { signals } = await signedPost<{ signals: Signal[] }>(`/overrides/${overrideId}/call/device/inbox`, { after });
    for (const s of signals) { after = Math.max(after, s.seq); await handle(s); }
    const now = Date.now();
    for (const [operator, p] of peers) {
      // Said again each minute while it holds: an approval reads a recent report.
      if (p.pc.connectionState === "connected" && now - p.lastReport > REPORT_MS) {
        p.lastReport = now;
        await signedPost(`/overrides/${overrideId}/call/device/state`, { operator, state: "connected" }).catch(() => undefined);
      }
    }
  } catch {
    // A failed poll is retried by the next one.
  }
}

async function openCall(): Promise<void> {
  overrideId = el<HTMLSelectElement>("request").value;
  if (!overrideId) throw new Error(t("c_no_request"));
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t("c_no_camera"));
  say(t("c_asking"));
  try {
    camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: true });
  } catch {
    // No microphone is survivable; no camera is not.
    camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
  }
  const preview = el<HTMLVideoElement>("preview");
  preview.srcObject = camera;
  preview.hidden = false;
  const joined = await signedPost<{ iceServers: RTCIceServer[] }>(`/overrides/${overrideId}/call/device/join`, {});
  iceServers = joined.iceServers;
  after = 0;
  el("open").hidden = true;
  el("close").hidden = false;
  describe();
  poll = setInterval(() => void tick(), POLL_MS);
}

async function closeCall(): Promise<void> {
  if (poll) clearInterval(poll);
  poll = null;
  const now = Date.now();
  for (const [operator, p] of peers) {
    p.pc.close();
    if (p.connectedAt) {
      await signedPost(`/overrides/${overrideId}/call/device/state`, {
        operator, state: "ended", seconds: Math.round((now - p.connectedAt) / 1000),
      }).catch(() => undefined);
    }
  }
  peers.clear();
  for (const t of camera?.getTracks() ?? []) t.stop();
  camera = null;
  const preview = el<HTMLVideoElement>("preview");
  preview.srcObject = null;
  preview.hidden = true;
  el("open").hidden = false;
  el("close").hidden = true;
  say(t("c_closed"));
}

async function load(): Promise<void> {
  identity = await setting<Identity>("identity");
  key = await setting<CryptoKey>("privateKey");
  if (!identity || !key) {
    el("device").textContent = t("c_not_enrolled");
    el<HTMLButtonElement>("open").disabled = true;
    return;
  }
  el("device").textContent = t("device", { id: identity.deviceId });
  const { requests } = await signedPost<{ requests: OwnRequest[] }>("/overrides/device-requests", {});
  const select = el<HTMLSelectElement>("request");
  const wanted = new URLSearchParams(location.search).get("override");
  select.replaceChildren(...requests.map((r) => {
    const option = document.createElement("option");
    option.value = r.id;
    option.selected = r.id === wanted;
    option.textContent = t("c_option", {
      serial: r.seal_serial ?? t("c_packet"), no: r.leg_no, from: r.from_place, to: r.to_place,
      standing: r.refused ? t("c_refused") : t("c_approvals", { n: r.approvals }),
    });
    return option;
  }));
  if (requests.length === 0) say(t("c_none_today"));
}

const run = (action: () => Promise<void>) => { void action().catch((err: unknown) => say((err as Error).message)); };
el("open").addEventListener("click", () => run(openCall));
el("close").addEventListener("click", () => run(closeCall));
window.addEventListener("pagehide", () => { void closeCall(); });
// The request list is worded in the language in use, so it is read again on a
// change; a call that is open is left alone.
el("lang").append(languageButton(() => { if (!poll) run(load); }));
applyLanguage();
run(load);
