import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DenyReason } from "@mohar/contracts";
import {
  DerError,
  bool,
  certificateExtension,
  children,
  octets,
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
 * What this does not cover is said in RUNNING.md: a TPM quote from a centre PC
 * is not understood here, and nothing in this repository produces an Android
 * attestation yet, because the field app is a web page and a web page cannot
 * ask the Keystore for one.
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
  | "boot_verified";

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
  if (input.roots.length === 0) {
    add("root_trusted", false, "no trusted root is configured on this ledger, so no chain can be trusted");
  } else {
    const anchored = input.roots.some((r) => {
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
        : `the chain ends at ${facts.rootSubject}, which is not one of the ${input.roots.length} configured root(s)`,
    );
  }

  if (!input.revocation) {
    add("not_revoked", undefined, "not evaluated: no revocation list is loaded on this ledger");
  } else {
    const listed = chain
      .map((c, i) => ({ i, status: input.revocation!(c.serialNumber.toLowerCase()) }))
      .filter((c) => c.status !== undefined);
    add(
      "not_revoked",
      listed.length === 0,
      listed.length === 0
        ? "no certificate in the chain is on the revocation list"
        : listed.map((c) => `certificate ${c.i + 1} is listed as ${c.status}`).join("; "),
    );
  }

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
