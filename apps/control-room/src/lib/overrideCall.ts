import { api, type CallSignal } from "./api";

/**
 * ── The override's video call, in the browser ────────────────────────────────
 *
 * Two ends. The phone at the packet sends its camera and microphone; an
 * operator receives them and may send a microphone back. The picture goes
 * between the two browsers directly. The ledger only carries the two set-up
 * messages (an offer and an answer, each with every network candidate already
 * in it) and records what each end reports.
 *
 * What each end reports is deliberately narrow. The operator's end reports
 * "connected" only with the number of video frames its browser has actually
 * decoded; a call that connects and shows nothing is reported as that. Neither
 * end can report for the other.
 *
 * The ends find each other through a public STUN server by default. There is
 * no relay: two networks that both refuse direct connections will not connect,
 * and the page says so instead of pretending.
 */

export type CallPhase =
  | "idle"
  | "starting"
  | "waiting" // on the call, nobody at the other end yet
  | "connecting"
  | "live"
  | "failed"
  | "ended";

export interface CallStatus {
  phase: CallPhase;
  detail: string;
  framesDecoded?: number;
}

const POLL_MS = 1500;
const GATHER_MS = 4000;
/** An approval reads a report at most fifteen minutes old; keep it fresher than that. */
const REPORT_MS = 60_000;
/** About a second and a half of picture before the operator's end says it saw video. */
const FIRST_REPORT_FRAMES = 15;

/** The local description once every candidate is in it, or after a few seconds. */
async function gathered(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("the browser produced no connection description");
  return sdp;
}

async function inboundVideo(pc: RTCPeerConnection): Promise<{ frames: number; width: number; height: number }> {
  const stats = await pc.getStats();
  let out = { frames: 0, width: 0, height: 0 };
  stats.forEach((s: { type?: string; kind?: string; framesDecoded?: number; frameWidth?: number; frameHeight?: number }) => {
    if (s.type === "inbound-rtp" && s.kind === "video") {
      out = { frames: s.framesDecoded ?? 0, width: s.frameWidth ?? 0, height: s.frameHeight ?? 0 };
    }
  });
  return out;
}

const FAILED_HELP =
  "The two ends could not reach each other directly. There is no relay server, so a network " +
  "that blocks direct connections stops the call. Try the phone on another network.";

// ── an operator's end ───────────────────────────────────────────────────────

export class OperatorCall {
  private pc: RTCPeerConnection | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private after = 0;
  private iceServers: RTCIceServer[] = [];
  private mic: MediaStream | null = null;
  private startedAt = 0;
  private lastReport = 0;
  private reportedFrames = false;
  private closed = false;

  constructor(
    private readonly overrideId: string,
    private readonly onStatus: (s: CallStatus) => void,
    private readonly onStream: (s: MediaStream | null) => void,
  ) {}

  async start(): Promise<void> {
    this.onStatus({ phase: "starting", detail: "Opening the call…" });
    const joined = await api.overrideCall.join(this.overrideId);
    this.iceServers = joined.iceServers;
    this.onStatus({
      phase: "waiting",
      detail: joined.devicePresent
        ? "The phone is on the call; waiting for its camera."
        : "Waiting for the officer to open the call on the phone that made this request.",
    });
    // A microphone is offered, not required: an operator who cannot be heard
    // can still see, and seeing is what the approval states.
    this.mic = await navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .catch(() => null) ?? null;
    this.poll = setInterval(() => void this.tick(), POLL_MS);
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const { signals } = await api.overrideCall.inbox(this.overrideId, this.after);
      for (const s of signals) {
        this.after = Math.max(this.after, s.seq);
        await this.handle(s);
      }
    } catch {
      // A failed poll is retried by the next one.
    }
  }

  private async handle(s: CallSignal): Promise<void> {
    if (s.kind === "bye") {
      this.dropPeer();
      this.onStatus({ phase: "waiting", detail: "The phone left the call." });
      return;
    }
    if (s.kind !== "offer" || !s.sdp) return;

    this.dropPeer();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.reportedFrames = false;
    pc.ontrack = (e) => this.onStream(e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "connected") {
        this.startedAt = Date.now();
        this.onStatus({ phase: "connecting", detail: "Connected; waiting for the first video frame." });
      } else if (pc.connectionState === "failed") {
        this.onStatus({ phase: "failed", detail: FAILED_HELP });
      }
    };
    this.onStatus({ phase: "connecting", detail: "The phone is calling; answering." });
    await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
    for (const track of this.mic?.getTracks() ?? []) pc.addTrack(track, this.mic!);
    await pc.setLocalDescription(await pc.createAnswer());
    await api.overrideCall.answer(this.overrideId, await gathered(pc));

    if (this.watch) clearInterval(this.watch);
    this.watch = setInterval(() => void this.report(pc), 1000);
  }

  /** Tell the ledger what this browser has actually decoded, and keep telling it. */
  private async report(pc: RTCPeerConnection): Promise<void> {
    if (pc !== this.pc || pc.connectionState !== "connected") return;
    const v = await inboundVideo(pc);
    const now = Date.now();
    if (v.frames > 0) {
      this.onStatus({ phase: "live", detail: "Live video from the phone.", framesDecoded: v.frames });
      const first = !this.reportedFrames && v.frames >= FIRST_REPORT_FRAMES;
      if (first || (this.reportedFrames && now - this.lastReport > REPORT_MS)) {
        this.reportedFrames = true;
        this.lastReport = now;
        await api.overrideCall
          .state(this.overrideId, { state: "connected", framesDecoded: v.frames, width: v.width, height: v.height })
          .catch(() => undefined);
      }
    } else if (now - this.startedAt > 8000 && now - this.lastReport > REPORT_MS) {
      // Connected and still nothing to see. Reported as exactly that.
      this.lastReport = now;
      this.onStatus({ phase: "connecting", detail: "Connected, but no video has arrived from the phone." });
      await api.overrideCall.state(this.overrideId, { state: "connected", framesDecoded: 0 }).catch(() => undefined);
    }
  }

  private dropPeer(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.pc?.close();
    this.pc = null;
    this.onStream(null);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.dropPeer();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.onStatus({ phase: "ended", detail: "Call closed." });
    await api.overrideCall.state(this.overrideId, { state: "ended", seconds }).catch(() => undefined);
  }
}

// ── the phone's end, for a console standing in for the handheld ─────────────

interface Peer {
  pc: RTCPeerConnection;
  name: string;
  connectedAt: number;
  lastReport: number;
}

export class PhoneCall {
  private readonly peers = new Map<string, Peer>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private after = 0;
  private iceServers: RTCIceServer[] = [];
  private camera: MediaStream | null = null;
  private closed = false;

  constructor(
    private readonly overrideId: string,
    private readonly deviceId: string,
    private readonly onStatus: (s: CallStatus) => void,
    private readonly onPreview: (s: MediaStream | null) => void,
  ) {}

  async start(): Promise<void> {
    this.onStatus({ phase: "starting", detail: "Asking for the camera…" });
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot open a camera. The call needs one.");
    }
    try {
      this.camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
    } catch {
      // No microphone is survivable; no camera is not.
      this.camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
    }
    this.onPreview(this.camera);
    const joined = await api.overrideCall.deviceJoin(this.overrideId, this.deviceId);
    this.iceServers = joined.iceServers;
    this.say();
    this.poll = setInterval(() => void this.tick(), POLL_MS);
  }

  private say(): void {
    const live = [...this.peers.values()].filter((p) => p.pc.connectionState === "connected");
    this.onStatus(
      live.length > 0
        ? { phase: "live", detail: `On the call with ${live.map((p) => p.name).join(" and ")}.` }
        : this.peers.size > 0
          ? { phase: "connecting", detail: "Calling the control room…" }
          : { phase: "waiting", detail: "Camera on. Waiting for a control room operator to open the call." },
    );
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const { signals } = await api.overrideCall.deviceInbox(this.overrideId, this.deviceId, this.after);
      for (const s of signals) {
        this.after = Math.max(this.after, s.seq);
        await this.handle(s);
      }
      const now = Date.now();
      for (const [accountId, p] of this.peers) {
        if (p.pc.connectionState === "connected" && now - p.lastReport > REPORT_MS) {
          p.lastReport = now;
          await api.overrideCall
            .deviceState(this.overrideId, this.deviceId, { operator: accountId, state: "connected" })
            .catch(() => undefined);
        }
      }
    } catch {
      // A failed poll is retried by the next one.
    }
  }

  private async handle(s: CallSignal): Promise<void> {
    if (s.kind === "operator-joined") {
      this.peers.get(s.from)?.pc.close();
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const peer: Peer = { pc, name: s.fromName ?? "an operator", connectedAt: 0, lastReport: 0 };
      this.peers.set(s.from, peer);
      for (const track of this.camera?.getTracks() ?? []) pc.addTrack(track, this.camera!);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") peer.connectedAt = Date.now();
        if (pc.connectionState === "failed") this.onStatus({ phase: "failed", detail: FAILED_HELP });
        else this.say();
      };
      await pc.setLocalDescription(await pc.createOffer());
      await api.overrideCall.deviceOffer(this.overrideId, this.deviceId, s.from, await gathered(pc));
      this.say();
    } else if (s.kind === "answer" && s.sdp) {
      const peer = this.peers.get(s.from);
      if (peer && peer.pc.signalingState === "have-local-offer") {
        await peer.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      }
    } else if (s.kind === "bye") {
      this.peers.get(s.from)?.pc.close();
      this.peers.delete(s.from);
      this.say();
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    const now = Date.now();
    for (const [accountId, p] of this.peers) {
      const seconds = p.connectedAt ? Math.round((now - p.connectedAt) / 1000) : 0;
      p.pc.close();
      if (p.connectedAt) {
        await api.overrideCall
          .deviceState(this.overrideId, this.deviceId, { operator: accountId, state: "ended", seconds })
          .catch(() => undefined);
      }
    }
    this.peers.clear();
    for (const t of this.camera?.getTracks() ?? []) t.stop();
    this.onPreview(null);
    this.onStatus({ phase: "ended", detail: "Call closed." });
  }
}
