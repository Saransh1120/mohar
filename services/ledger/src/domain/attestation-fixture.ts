import { X509Certificate, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * ── Attestation chains for tests ─────────────────────────────────────────────
 *
 * node:crypto cannot issue certificates, so these are built byte by byte in the
 * shape Android's Keystore produces: a root, an intermediate, and a leaf over
 * an Ed25519 key carrying the key description extension.
 *
 * Used by attestation.test.ts and tools/e2e/attestation.mjs. No route imports
 * this file, and nothing made here is trusted by a running ledger unless a
 * test hands it in as a root.
 */

// ── a DER writer, the mirror of der.ts ──

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number | number[], ...content: Uint8Array[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from(Array.isArray(tag) ? tag : [tag]), len(body.length), body]);
};
const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
const int = (n: number) => {
  const bytes: number[] = [];
  for (let v = n; ; v = Math.floor(v / 256)) {
    bytes.unshift(v % 256);
    if (v < 256) break;
  }
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};
const enumerated = (n: number) => tlv(0x0a, Buffer.from([n]));
const octet = (b: Uint8Array) => tlv(0x04, b);
const boolean = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bits = (b: Uint8Array) => tlv(0x03, Buffer.from([0]), b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const oid = (dotted: string) => {
  const p = dotted.split(".").map(Number);
  const out: number[] = [p[0]! * 40 + p[1]!];
  for (const n of p.slice(2)) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
};
const utcTime = (d: Date) =>
  tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));
/** [n] EXPLICIT, context-specific and constructed. 704 needs the long tag form. */
const explicit = (n: number, inner: Uint8Array) =>
  tlv(n < 31 ? 0xa0 | n : [0xbf, 0x80 | (n >> 7), n & 0x7f], inner);

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
export const DAY = 86_400_000;

export interface CertSpec {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  signerKey: KeyObject;
  serial?: number;
  notBefore?: Date;
  notAfter?: Date;
  /** The moment the certificate is made for; it is valid a year either side. */
  now?: Date;
  ca?: boolean;
  keyDescription?: Buffer;
}

export function certificate(s: CertSpec): Buffer {
  const at = (s.now ?? new Date()).getTime();
  const extensions: Buffer[] = [];
  if (s.ca) extensions.push(seq(oid("2.5.29.19"), boolean(true), octet(seq(boolean(true)))));
  if (s.keyDescription) extensions.push(seq(oid("1.3.6.1.4.1.11129.2.1.17"), octet(s.keyDescription)));
  const tbs = seq(
    explicit(0, int(2)),
    int(s.serial ?? 1000 + Math.floor(Math.random() * 100000)),
    ECDSA_SHA256,
    name(s.issuer),
    seq(utcTime(s.notBefore ?? new Date(at - 365 * DAY)), utcTime(s.notAfter ?? new Date(at + 365 * DAY))),
    name(s.subject),
    s.subjectKey.export({ type: "spki", format: "der" }),
    ...(extensions.length ? [explicit(3, seq(...extensions))] : []),
  );
  return seq(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, s.signerKey)));
}

export interface DescriptionSpec {
  attestationLevel?: number;
  keyMintLevel?: number;
  challenge: Uint8Array;
  deviceLocked?: boolean;
  bootState?: number;
  noRootOfTrust?: boolean;
  /** Put the root of trust in the software list instead, where it proves nothing. */
  rootOfTrustInSoftware?: boolean;
}

export function keyDescription(d: DescriptionSpec): Buffer {
  const rot = explicit(
    704,
    seq(octet(randomBytes(32)), boolean(d.deviceLocked ?? true), enumerated(d.bootState ?? 0), octet(randomBytes(32))),
  );
  const none = d.noRootOfTrust === true;
  return seq(
    int(300),
    enumerated(d.attestationLevel ?? 1),
    int(300),
    enumerated(d.keyMintLevel ?? 1),
    octet(d.challenge),
    octet(Buffer.alloc(0)),
    seq(...(!none && d.rootOfTrustInSoftware ? [rot] : [])),
    seq(...(!none && !d.rootOfTrustInSoftware ? [rot] : [])),
  );
}

export const ec = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

/** A vendor: a root and an intermediate that issues leaves. */
export function vendor(label: string, now: Date = new Date()) {
  const root = ec();
  const mid = ec();
  const rootCert = certificate({
    subject: `${label} root`, issuer: `${label} root`, subjectKey: root.publicKey, signerKey: root.privateKey, ca: true, now,
  });
  const midCert = certificate({
    subject: `${label} intermediate`, issuer: `${label} root`, subjectKey: mid.publicKey, signerKey: root.privateKey,
    ca: true, serial: 7001, now,
  });
  return { root, mid, rootCert, midCert, x509: new X509Certificate(rootCert) };
}

/** The raw 32 bytes of an Ed25519 public key, as the hex a device enrols with. */
export function ed25519Hex(key: KeyObject): string {
  return Buffer.from(String(key.export({ format: "jwk" }).x), "base64url").toString("hex");
}

/** A fresh device key and the leaf certificate a vendor's hardware would issue over it. */
export function attestedKey(
  issuer: ReturnType<typeof vendor>,
  description: DescriptionSpec,
  leaf: Partial<CertSpec> = {},
): { pubkeyHex: string; privateKey: KeyObject; leaf: Buffer } {
  const key = generateKeyPairSync("ed25519");
  return {
    pubkeyHex: ed25519Hex(key.publicKey),
    privateKey: key.privateKey,
    leaf: certificate({
      subject: "Android Keystore Key",
      issuer: new X509Certificate(issuer.midCert).subject.replace(/^CN=/, ""),
      subjectKey: key.publicKey,
      signerKey: issuer.mid.privateKey,
      serial: 424242,
      keyDescription: keyDescription(description),
      ...leaf,
    }),
  };
}
