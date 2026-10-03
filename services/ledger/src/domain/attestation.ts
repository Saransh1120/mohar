import { X509Certificate, createHash, verify as verifySignature } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DenyReason } from "@mohar/contracts";
import {
  DerError,
  bool,
  certificateExtension,
  children,
  octets,
  oid,
  readTlv,
  sequence,
  smallInt,
  splitDer,
  type Tlv,
} from "./der.js";

/**
 * ── Is this key held where the phone says it is ──────────────────────────────
 *
 * At enrolment a phone may present an Android key attestation: a certificate
 * chain in which the phone's secure hardware states that the key being enrolled
 * was generated inside it, cannot be exported, and that the phone booted a
 * verified, locked operating system. The chain ends at a root the hardware
 * vendor publishes. adr/0003 is why this and not an MDM.
 *
 * Every check below is evaluated and reported, not just the first that fails.
 * A check that could not be run says so and why; it is never counted as passed.
 *
 * A centre PC has a TPM instead, and a TPM cannot do the same thing: it does not
 * hold Ed25519 keys, so the key a PC enrols with is never inside it. What a TPM
 * can do is sign, with an attestation key its maker's CA certified, a statement
 * naming that key and this ledger's challenge. That is checked in the second
 * half of this file and it proves less: a real TPM was at the enrolment and
 * vouched for the key, not that the key cannot be copied off the PC.
 *
 * Nothing in this repository produces either kind yet. The field app is a web
 * page and cannot ask a Keystore; there is no centre PC client. RUNNING.md says
 * what has and has not been put to these checks.
 */

export type AttestationCheckName =
  | "chain_readable"
  | "chain_links"
  | "chain_in_date"
  | "root_trusted"
  | "not_revoked"
  | "key_description"
  | "hardware_backed"
  | "challenge_fresh"
  | "key_is_enrolled_key"
  | "boot_verified"
  // A TPM's statement about a key it does not hold.
  | "bundle_readable"
  | "ak_certificate"
  | "quote_structure"
  | "quote_signed"
  | "binding_fresh"
  | "boot_measured";

export const ATTESTATION_CHECKS: readonly AttestationCheckName[] = Object.freeze([
  "chain_readable",
  "chain_links",
  "chain_in_date",
  "root_trusted",
  "not_revoked",
  "key_description",
  "hardware_backed",
  "challenge_fresh",
  "key_is_enrolled_key",
  "boot_verified",
]);

export const TPM_ATTESTATION_CHECKS: readonly AttestationCheckName[] = Object.freeze([
  "bundle_readable",
  "chain_links",
  "chain_in_date",
  "root_trusted",
  "not_revoked",
  "ak_certificate",
  "quote_structure",
  "quote_signed",
  "binding_fresh",
  "boot_measured",
]);

export interface AttestationCheck {
  check: AttestationCheckName;
  /** Undefined where the check could not be run. Not run is not passed. */
  passed: boolean | undefined;
  evidence: string;
  reason?: DenyReason;
}

export interface AttestationRuling {
  /** `absent` when nothing was presented: there was nothing to rule on. */
  outcome: "verified" | "refused" | "absent";
  checks: AttestationCheck[];
  /** What the chain said about the key, where it could be read. No key material. */
  facts: {
    /** Which kind of statement was presented. */
    kind?: "android-key" | "tpm-quote";
    /** In words: where the enrolled key is, as far as the statement shows. */
    keyHeldIn?: string;
    tpmFirmwareVersion?: string;
    tpmResetCount?: number;
    certificates?: number;
    attestationVersion?: number;
    attestationSecurityLevel?: string;
    keyMintSecurityLevel?: string;
    verifiedBootState?: string;
    deviceLocked?: boolean;
    leafSerial?: string;
    rootSubject?: string;
  };
}

const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const ROOT_OF_TRUST_TAG = 704;
const SECURITY_LEVEL = ["Software", "TrustedEnvironment", "StrongBox"] as const;
const BOOT_STATE = ["Verified", "SelfSigned", "Unverified", "Failed"] as const;

interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: number;
  keyMintSecurityLevel: number;
  challenge: Uint8Array;
  /** From the hardware-enforced list only. One the software wrote proves nothing. */
  rootOfTrust: { deviceLocked: boolean; verifiedBootState: number } | null;
}

/**
 *   KeyDescription ::= SEQUENCE {
 *     attestationVersion INTEGER, attestationSecurityLevel ENUMERATED,
 *     keyMintVersion INTEGER,     keyMintSecurityLevel ENUMERATED,
 *     attestationChallenge OCTET STRING, uniqueId OCTET STRING,
 *     softwareEnforced AuthorizationList, hardwareEnforced AuthorizationList }
 *   RootOfTrust ::= SEQUENCE { verifiedBootKey OCTET STRING, deviceLocked BOOLEAN,
 *     verifiedBootState ENUMERATED, verifiedBootHash OCTET STRING OPTIONAL }
 */
export function parseKeyDescription(extensionValue: Uint8Array): KeyDescription {
  const f = sequence(readTlv(extensionValue).tlv, "the key description");
  if (f.length < 8) throw new DerError("the key description has fewer than eight fields");
  const hardware = sequence(f[7], "the hardware-enforced list");
  const tagged = hardware.find((t: Tlv) => t.cls === 2 && t.tag === ROOT_OF_TRUST_TAG);
  let rootOfTrust: KeyDescription["rootOfTrust"] = null;
  if (tagged) {
    const rot = sequence(children(tagged)[0], "the root of trust");
    octets(rot[0], "the verified boot key");
    rootOfTrust = {
      deviceLocked: bool(rot[1], "deviceLocked"),
      verifiedBootState: smallInt(rot[2], "verifiedBootState"),
    };
  }
  return {
    attestationVersion: smallInt(f[0], "attestationVersion"),
    attestationSecurityLevel: smallInt(f[1], "attestationSecurityLevel"),
    keyMintSecurityLevel: smallInt(f[3], "keyMintSecurityLevel"),
    challenge: octets(f[4], "attestationChallenge"),
    rootOfTrust,
  };
}

/** A PEM bundle, or DER certificates one after another. Leaf first. */
export function parseChain(attestation: Uint8Array): X509Certificate[] {
  const text = Buffer.from(attestation).toString("latin1");
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    return blocks.map((b) => new X509Certificate(b));
  }
  return splitDer(attestation).map((der) => new X509Certificate(Buffer.from(der)));
}

function spki(cert: X509Certificate): string {
  return cert.publicKey.export({ type: "spki", format: "der" }).toString("hex");
}

/** The raw 32 bytes of an Ed25519 certificate key as hex, or null for any other key. */
function ed25519Raw(cert: X509Certificate): string | null {
  if (cert.publicKey.asymmetricKeyType !== "ed25519") return null;
  const x = cert.publicKey.export({ format: "jwk" }).x;
  return typeof x === "string" ? Buffer.from(x, "base64url").toString("hex") : null;
}

export interface AttestationInput {
  /** The bytes presented, or undefined when the enrolment carried none. */
  attestation: Uint8Array | undefined;
  /** The key being enrolled. */
  pubkeyHex: string;
  /** The challenge this ledger issued for that key, if one is outstanding. */
  expectedChallenge: Uint8Array | null;
  roots: readonly X509Certificate[];
  /** Roots that certify TPM attestation keys. A different trust from a phone's. */
  tpmRoots?: readonly X509Certificate[] | undefined;
  /**
   * Looks a certificate serial up in the vendor's revocation list. Omitted when
   * no list has been loaded; the check is then reported as not evaluated.
   */
  revocation?: ((serialHex: string) => string | undefined) | undefined;
  now?: Date | undefined;
}

export function verifyAttestation(input: AttestationInput): AttestationRuling {
  if (!input.attestation || input.attestation.length === 0) {
    return { outcome: "absent", checks: [], facts: {} };
  }
  const now = input.now ?? new Date();
  const checks: AttestationCheck[] = [];
  const facts: AttestationRuling["facts"] = {};
  const add = (check: AttestationCheckName, passed: boolean | undefined, evidence: string) => {
    checks.push({
      check,
      passed,
      evidence,
      ...(passed === false ? { reason: "device_attestation_invalid" as const } : {}),
    });
  };
  const skip = (names: readonly AttestationCheckName[], why: string) => {
    for (const n of names) add(n, undefined, `not evaluated: ${why}`);
  };
  const finish = (): AttestationRuling => ({
    outcome: checks.every((c) => c.passed !== false) && checks.some((c) => c.passed) ? "verified" : "refused",
    checks,
    facts,
  });

  // A TPM's statement is a small JSON bundle; a phone's is a certificate
  // chain. Neither can be mistaken for the other from its first byte.
  if (Buffer.from(input.attestation.subarray(0, 16)).toString("latin1").trimStart().startsWith("{")) {
    verifyTpmQuote(input, now, add, skip, facts);
    return finish();
  }
  facts.kind = "android-key";

  // ── the chain itself ──
  let chain: X509Certificate[];
  try {
    chain = parseChain(input.attestation);
  } catch (err) {
    add("chain_readable", false, `what was presented is not a certificate chain: ${(err as Error).message}`);
    skip(ATTESTATION_CHECKS.slice(1), "the chain could not be read");
    return finish();
  }
  if (chain.length < 2) {
    add("chain_readable", false, `${chain.length} certificate(s) presented; a chain needs the key's certificate and its issuers`);
    skip(ATTESTATION_CHECKS.slice(1), "there is no chain to check");
    return finish();
  }
  facts.certificates = chain.length;
  facts.leafSerial = chain[0]!.serialNumber.toLowerCase();
  add("chain_readable", true, `${chain.length} certificates, leaf first`);

  chainChecks(chain, input.roots, input.revocation, now, add, facts);

  // ── what the hardware said about the key ──
  let description: KeyDescription | null = null;
  try {
    const ext = certificateExtension(new Uint8Array(chain[0]!.raw), KEY_DESCRIPTION_OID);
    if (!ext) {
      add("key_description", false, "the key's certificate carries no Android key description");
    } else {
      description = parseKeyDescription(ext);
      facts.attestationVersion = description.attestationVersion;
      facts.attestationSecurityLevel = SECURITY_LEVEL[description.attestationSecurityLevel] ?? "unknown";
      facts.keyMintSecurityLevel = SECURITY_LEVEL[description.keyMintSecurityLevel] ?? "unknown";
      add("key_description", true, `key description version ${description.attestationVersion}`);
    }
  } catch (err) {
    add("key_description", false, `the key description could not be read: ${(err as Error).message}`);
  }

  if (!description) {
    skip(["hardware_backed", "challenge_fresh"], "there is no key description to read");
  } else {
    const hardware =
      (description.attestationSecurityLevel === 1 || description.attestationSecurityLevel === 2) &&
      (description.keyMintSecurityLevel === 1 || description.keyMintSecurityLevel === 2);
    add(
      "hardware_backed",
      hardware,
      `attested by ${facts.attestationSecurityLevel}; key held in ${facts.keyMintSecurityLevel}` +
        (hardware ? "" : ". A key a program holds can be copied off the phone"),
    );

    const got = Buffer.from(description.challenge);
    add(
      "challenge_fresh",
      input.expectedChallenge !== null && got.equals(Buffer.from(input.expectedChallenge)),
      input.expectedChallenge === null
        ? "this ledger has no challenge outstanding for this key, so the attestation could have been made at any time"
        : got.equals(Buffer.from(input.expectedChallenge))
          ? "the attestation answers the challenge this ledger issued"
          : "the attestation answers a different challenge from the one this ledger issued",
    );
  }

  const leafKey = ed25519Raw(chain[0]!);
  add(
    "key_is_enrolled_key",
    leafKey === input.pubkeyHex,
    leafKey === null
      ? `the attested key is ${chain[0]!.publicKey.asymmetricKeyType ?? "of an unknown type"}, not Ed25519`
      : leafKey === input.pubkeyHex
        ? "the attested key is the key being enrolled"
        : "the attested key is not the key being enrolled",
  );

  if (!description) {
    skip(["boot_verified"], "there is no key description to read");
  } else if (!description.rootOfTrust) {
    add("boot_verified", false, "the hardware reported no boot state");
  } else {
    const rot = description.rootOfTrust;
    facts.deviceLocked = rot.deviceLocked;
    facts.verifiedBootState = BOOT_STATE[rot.verifiedBootState] ?? "unknown";
    add(
      "boot_verified",
      rot.deviceLocked && rot.verifiedBootState === 0,
      `bootloader ${rot.deviceLocked ? "locked" : "unlocked"}; boot state ${facts.verifiedBootState}`,
    );
  }

  return finish();
}

type Add = (check: AttestationCheckName, passed: boolean | undefined, evidence: string) => void;

/**
 * The four checks any certificate chain is put to, whoever issued it: each
 * certificate signed by the next, all in date, ending at a configured root,
 * and none on a loaded revocation list.
 */
function chainChecks(
  chain: readonly X509Certificate[],
  roots: readonly X509Certificate[],
  revocation: ((serialHex: string) => string | undefined) | undefined,
  now: Date,
  add: Add,
  facts: AttestationRuling["facts"],
): void {
  const broken: string[] = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const cert = chain[i]!;
    const issuer = chain[i + 1]!;
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
      broken.push(`certificate ${i + 1} is not signed by certificate ${i + 2}`);
    }
  }
  add(
    "chain_links",
    broken.length === 0,
    broken.length === 0 ? "each certificate is signed by the next" : broken.join("; "),
  );

  const outOfDate = chain
    .map((c, i) => ({ i, from: new Date(c.validFrom), to: new Date(c.validTo) }))
    .filter((c) => now < c.from || now > c.to);
  add(
    "chain_in_date",
    outOfDate.length === 0,
    outOfDate.length === 0
      ? `every certificate is valid at ${now.toISOString()}`
      : outOfDate
          .map((c) => `certificate ${c.i + 1} is valid ${c.from.toISOString()} to ${c.to.toISOString()}`)
          .join("; "),
  );

  // ── where the chain ends ──
  // Compared by public key, not by certificate: a vendor may reissue its root
  // certificate over the same key, and it is the key that is trusted.
  const top = chain[chain.length - 1]!;
  facts.rootSubject = top.subject.replace(/\n/g, ", ");
  if (roots.length === 0) {
    add("root_trusted", false, "no trusted root is configured on this ledger, so no chain can be trusted");
  } else {
    const anchored = roots.some((r) => {
      if (spki(r) === spki(top)) return true;
      try {
        return top.checkIssued(r) && top.verify(r.publicKey);
      } catch {
        return false;
      }
    });
    add(
      "root_trusted",
      anchored,
      anchored
        ? `the chain ends at a configured root (${facts.rootSubject})`
        : `the chain ends at ${facts.rootSubject}, which is not one of the ${roots.length} configured root(s)`,
    );
  }

  if (!revocation) {
    add("not_revoked", undefined, "not evaluated: no revocation list is loaded on this ledger");
  } else {
    const listed = chain
      .map((c, i) => ({ i, status: revocation(c.serialNumber.toLowerCase()) }))
      .filter((c) => c.status !== undefined);
    add(
      "not_revoked",
      listed.length === 0,
      listed.length === 0
        ? "no certificate in the chain is on the revocation list"
        : listed.map((c) => `certificate ${c.i + 1} is listed as ${c.status}`).join("; "),
    );
  }
}

// ── a TPM's statement ──────────────────────────────────────────────────────

/** The label the binding digest starts with, so it can be nothing else's digest. */
export const TPM_BINDING_LABEL = "MOHAR-TPM-BIND-v1";
export const TPM_BUNDLE_FORMAT = "tpm2-quote-v1";
const AIK_CERTIFICATE_EKU = "2.23.133.8.3";
const TPM_GENERATED_VALUE = 0xff544347;
const TPM_ST_ATTEST_QUOTE = 0x8018;

/**
 * What the TPM is asked to sign over: this ledger's challenge and the key
 * being enrolled, under a label. The quote's `extraData` must equal this.
 */
export function tpmBinding(challenge: Uint8Array, pubkeyHex: string): Buffer {
  return createHash("sha256")
    .update(TPM_BINDING_LABEL)
    .update(Buffer.from([0]))
    .update(challenge)
    .update(Buffer.from(pubkeyHex, "hex"))
    .digest();
}

interface Quote {
  extraData: Buffer;
  firmwareVersion: bigint;
  resetCount: number;
}

/**
 * TPMS_ATTEST for a quote (TPM 2.0 Part 2, 10.12.8), big-endian throughout:
 *
 *   magic UINT32 | type UINT16 | qualifiedSigner TPM2B | extraData TPM2B |
 *   clock UINT64 | resetCount UINT32 | restartCount UINT32 | safe BYTE |
 *   firmwareVersion UINT64 | attested (PCR selection and digest)
 */
export function parseQuote(quoted: Uint8Array): Quote {
  const b = Buffer.from(quoted);
  let i = 0;
  const need = (n: number, what: string) => {
    if (i + n > b.length) throw new DerError(`the quote ends inside ${what}`);
  };
  need(6, "its header");
  if (b.readUInt32BE(0) !== TPM_GENERATED_VALUE) {
    throw new DerError("the structure does not begin with the mark a TPM puts on what it generates");
  }
  if (b.readUInt16BE(4) !== TPM_ST_ATTEST_QUOTE) throw new DerError("the structure is not a quote");
  i = 6;
  const sized = (what: string): Buffer => {
    need(2, what);
    const n = b.readUInt16BE(i);
    i += 2;
    need(n, what);
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };
  sized("the signer's name");
  const extraData = sized("the extra data");
  need(25, "the clock and firmware fields");
  const resetCount = b.readUInt32BE(i + 8);
  const firmwareVersion = b.readBigUInt64BE(i + 17);
  return { extraData, firmwareVersion, resetCount };
}

type Skip = (names: readonly AttestationCheckName[], why: string) => void;

function verifyTpmQuote(
  input: AttestationInput,
  now: Date,
  add: Add,
  skip: Skip,
  facts: AttestationRuling["facts"],
): void {
  facts.kind = "tpm-quote";
  // Said on every ruling of this kind, passed or not: this is what the check
  // can show at most.
  facts.keyHeldIn = "software on the PC; a TPM signed for it at enrolment and does not hold it";

  // ── the bundle ──
  let chain: X509Certificate[];
  let quoted: Buffer;
  let signature: Buffer;
  try {
    const bundle = JSON.parse(Buffer.from(input.attestation!).toString("utf8")) as {
      format?: unknown; akChain?: unknown; quoted?: unknown; signature?: unknown;
    };
    if (bundle.format !== TPM_BUNDLE_FORMAT) throw new Error(`format is not ${TPM_BUNDLE_FORMAT}`);
    if (!Array.isArray(bundle.akChain) || bundle.akChain.length < 2 || !bundle.akChain.every((c) => typeof c === "string")) {
      throw new Error("akChain must be the attestation key's certificate and its issuers");
    }
    if (typeof bundle.quoted !== "string" || typeof bundle.signature !== "string") {
      throw new Error("quoted and signature must both be present");
    }
    chain = bundle.akChain.map((c) => new X509Certificate(Buffer.from(c as string, "base64")));
    quoted = Buffer.from(bundle.quoted, "base64");
    signature = Buffer.from(bundle.signature, "base64");
  } catch (err) {
    add("bundle_readable", false, `what was presented is not a TPM quote bundle: ${(err as Error).message}`);
    skip(TPM_ATTESTATION_CHECKS.slice(1), "the bundle could not be read");
    return;
  }
  facts.certificates = chain.length;
  facts.leafSerial = chain[0]!.serialNumber.toLowerCase();
  add("bundle_readable", true, `a quote, its signature and ${chain.length} certificates`);

  chainChecks(chain, input.tpmRoots ?? [], input.revocation, now, add, facts);

  // ── is the signing key a TPM's attestation key ──
  const ak = chain[0]!;
  let usages: string[] = [];
  try {
    const eku = certificateExtension(new Uint8Array(ak.raw), "2.5.29.37");
    usages = eku ? sequence(readTlv(eku).tlv, "the key usages").map((u) => oid(u)) : [];
  } catch {
    usages = [];
  }
  add(
    "ak_certificate",
    usages.includes(AIK_CERTIFICATE_EKU),
    usages.includes(AIK_CERTIFICATE_EKU)
      ? "the signing certificate is issued as a TPM attestation key certificate"
      : "the signing certificate is not issued as a TPM attestation key certificate, so its key need not be in a TPM",
  );

  // ── the quote ──
  let quote: Quote | null = null;
  try {
    quote = parseQuote(quoted);
    facts.tpmFirmwareVersion = quote.firmwareVersion.toString(16);
    facts.tpmResetCount = quote.resetCount;
    add("quote_structure", true, "a quote generated inside a TPM");
  } catch (err) {
    add("quote_structure", false, (err as Error).message);
  }

  let signed = false;
  try {
    signed = verifySignature("sha256", quoted, ak.publicKey, signature);
  } catch {
    signed = false;
  }
  add(
    "quote_signed",
    signed,
    signed
      ? "the quote is signed by the attestation key in the certificate"
      : "the signature over the quote does not verify with the attestation key in the certificate",
  );

  if (!quote) {
    skip(["binding_fresh"], "the quote could not be read");
  } else if (input.expectedChallenge === null) {
    add(
      "binding_fresh",
      false,
      "this ledger has no challenge outstanding for this key, so the quote could have been made at any time",
    );
  } else {
    const bound = quote.extraData.equals(tpmBinding(input.expectedChallenge, input.pubkeyHex));
    add(
      "binding_fresh",
      bound,
      bound
        ? "the quote names the key being enrolled and answers the challenge this ledger issued"
        : "the quote does not name this key together with the challenge this ledger issued",
    );
  }

  // The quote carries a digest of the PC's boot measurements. Judging it needs
  // the values a known-good build of that PC produces, and there are none here.
  add("boot_measured", undefined, "not evaluated: this ledger holds no reference boot measurements for centre PCs");
}

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Every `.pem` in the roots directory, each of which may hold several
 * certificates. A missing directory is no roots, and with no roots every
 * presented attestation is refused: unknown is not trusted.
 */
export function loadRoots(dir: string): { roots: X509Certificate[]; problems: string[] } {
  const roots: X509Certificate[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pem")).sort();
  } catch {
    return { roots, problems: [`${dir} could not be read`] };
  }
  for (const name of names) {
    try {
      roots.push(...parseChain(readFileSync(join(dir, name))));
    } catch (err) {
      problems.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { roots, problems };
}

// ── challenges ──────────────────────────────────────────────────────────────

const CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * Challenges this process has issued, by the key they were issued for.
 *
 * In memory: a restart forgets them, and an enrolment in flight across a
 * restart has to ask again. One per key, used once, gone after ten minutes.
 */
export class ChallengeBook {
  private readonly open = new Map<string, { challenge: Uint8Array; expiresAt: number }>();

  issue(pubkeyHex: string, challenge: Uint8Array, now: Date = new Date()): Date {
    for (const [k, v] of this.open) if (v.expiresAt <= now.getTime()) this.open.delete(k);
    const expiresAt = now.getTime() + CHALLENGE_TTL_MS;
    this.open.set(pubkeyHex, { challenge, expiresAt });
    return new Date(expiresAt);
  }

  /** The outstanding challenge for a key, removed as it is read. */
  take(pubkeyHex: string, now: Date = new Date()): Uint8Array | null {
    const entry = this.open.get(pubkeyHex);
    this.open.delete(pubkeyHex);
    return entry && entry.expiresAt > now.getTime() ? entry.challenge : null;
  }
}
