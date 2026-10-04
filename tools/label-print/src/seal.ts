import { randomUUID } from "node:crypto";
import { EVENT_SCHEMA_VERSION, type EventBody, type SignedEvent } from "@mohar/contracts";
import {
  encodeSeamQr,
  generateKeypair,
  generateSeamLabel,
  signBody,
} from "@mohar/crypto-core";
import { renderLabelPdf, renderLabelSvg, type LabelArt, type LabelInput } from "./label.js";

/**
 * ── The press operator's device, as a library ────────────────────────────────
 *
 * Printing and sealing are two steps because they are two moments. The label
 * is printed, stuck across the flap and photographed; only then does the
 * device sign that the packet is sealed, with the hash of that photograph in
 * the signed body.
 *
 * Between the two, the only thing kept is the commitment. The seam secret is
 * generated here, drawn into the two QR codes, and dropped: it is on the label
 * and nowhere else. A label that is lost before it is applied cannot be
 * reprinted, only replaced by a new one with a new secret.
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

/** The two calls this tool makes. Injected, so tests can hand it a server in memory. */
export interface Api {
  get(path: string): Promise<ApiResult>;
  post(path: string, body: unknown): Promise<ApiResult>;
}

/**
 * `headers` is what identifies the caller to a gateway, where there is one:
 * an operator's session, from @mohar/ledger-client. The sealing itself needs
 * none, because the signed event is its own credential; reading the packet and
 * enrolling the press device do.
 */
export function httpApi(base: string, headers: Readonly<Record<string, string>> = {}): Api {
  const root = base.replace(/\/+$/, "");
  const read = async (res: Response): Promise<ApiResult> => ({
    status: res.status,
    body: await res.json().catch(() => null),
  });
  return {
    get: async (path) => read(await fetch(`${root}${path}`, { headers })),
    post: async (path, body) =>
      read(
        await fetch(`${root}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      ),
  };
}

export interface PacketInfo {
  id: string;
  examId: string;
  centreId: string;
  centreCode: string;
  copies: number;
  sealSerial: string | null;
}

export async function loadPacket(api: Api, packageId: string): Promise<PacketInfo> {
  const res = await api.get(`/packages/${packageId}`);
  if (res.status === 404) throw new Error(`the ledger has no package ${packageId}`);
  if (res.status !== 200) throw new Error(`reading the package failed: ${res.status} ${JSON.stringify(res.body)}`);
  const p = res.body as Partial<PacketInfo>;
  if (!p.id || !p.examId || !p.centreId || typeof p.copies !== "number") {
    throw new Error("the ledger's answer for this package is missing fields this tool needs");
  }
  return {
    id: p.id,
    examId: p.examId,
    centreId: p.centreId,
    centreCode: p.centreCode ?? "",
    copies: p.copies,
    sealSerial: p.sealSerial ?? null,
  };
}

/** What is kept between printing and sealing. No secret is in it. */
export interface PendingLabel {
  packageId: string;
  packetSerial: string;
  seamId: string;
  labelCommitment: string;
  labelsPerPacket: 1 | 2;
  printedAt: string;
}

export interface PrintedLabel {
  art: LabelArt;
  /** The same label as a one-page PDF at print size. */
  pdf: Uint8Array;
  pending: PendingLabel;
}

export function makeLabel(
  packet: PacketInfo,
  opts: { verifyHost: string; labelsPerPacket: 1 | 2; packetSerial?: string; now?: Date },
): PrintedLabel {
  const packetSerial = opts.packetSerial ?? packet.sealSerial;
  if (!packetSerial) {
    throw new Error("this package has no serial planned; pass --serial to print one on the label");
  }
  if (packet.sealSerial && packet.sealSerial !== packetSerial) {
    throw new Error(
      `the serial planned for this package is ${packet.sealSerial}, not ${packetSerial}`,
    );
  }
  const label = generateSeamLabel();
  const drawing: LabelInput = {
    seamId: label.seamId,
    urlA: encodeSeamQr(opts.verifyHost, "A", label.seamId, label.shareA),
    urlB: encodeSeamQr(opts.verifyHost, "B", label.seamId, label.shareB),
    packetSerial,
    copies: opts.labelsPerPacket,
  };
  return {
    art: renderLabelSvg(drawing),
    pdf: renderLabelPdf(drawing),
    pending: {
      packageId: packet.id,
      packetSerial,
      seamId: label.seamId,
      labelCommitment: label.commitment,
      labelsPerPacket: opts.labelsPerPacket,
      printedAt: (opts.now ?? new Date()).toISOString(),
    },
  };
}

export interface Device {
  deviceId: string;
  privateKeyHex: string;
}

/** Enrol a new handheld with the ledger and return its identity. */
export async function enrolDevice(api: Api): Promise<Device> {
  const kp = generateKeypair();
  const res = await api.post("/devices", { kind: "field", pubkeyHex: kp.publicKeyHex });
  const id = (res.body as { id?: string } | null)?.id;
  if (res.status >= 300 || !id) {
    throw new Error(`enrolling the press device failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { deviceId: id, privateKeyHex: kp.privateKeyHex };
}

export interface SealOptions {
  /** SHA-256 of the photograph of the label on the closed packet. */
  photoSha256: string;
  personId?: string;
  paperCount?: number;
  geo?: { lat: number; lon: number; accuracyM: number };
  now?: Date;
}

/** The signed SEAL_APPLIED this device sends. Optional fields are left out, never null. */
export function buildSealEvent(
  packet: PacketInfo,
  pending: PendingLabel,
  device: Device,
  opts: SealOptions,
): SignedEvent {
  if (pending.packageId !== packet.id) {
    throw new Error("the printed label belongs to a different package");
  }
  const body = {
    v: EVENT_SCHEMA_VERSION,
    id: randomUUID(),
    examId: packet.examId,
    packageId: packet.id,
    centreId: packet.centreId,
    kind: "SEAL_APPLIED",
    occurredAt: (opts.now ?? new Date()).toISOString(),
    actorDeviceId: device.deviceId,
    ...(opts.personId ? { actorPersonId: opts.personId } : {}),
    ...(opts.geo ? { geo: opts.geo } : {}),
    payload: {
      sealSerial: pending.packetSerial,
      photoSha256: opts.photoSha256,
      seamId: pending.seamId,
      labelCommitment: pending.labelCommitment,
      labelsPerPacket: pending.labelsPerPacket,
      paperCount: opts.paperCount ?? packet.copies,
    },
  } as EventBody;
  return { body, deviceSig: signBody(body, device.privateKeyHex) };
}

export interface SealResult {
  sealed: boolean;
  status: number;
  body: unknown;
}

export async function submitSeal(api: Api, signed: SignedEvent): Promise<SealResult> {
  const res = await api.post(`/packages/${signed.body.packageId}/seal`, signed);
  return { sealed: res.status === 200 || res.status === 201, status: res.status, body: res.body };
}
