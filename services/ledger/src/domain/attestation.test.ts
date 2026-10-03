import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  ATTESTATION_CHECKS,
  ChallengeBook,
  TPM_ATTESTATION_CHECKS,
  tpmBinding,
  verifyAttestation,
  type AttestationInput,
  type AttestationRuling,
} from "./attestation.js";
import { DerError, certificateExtension, readTlv } from "./der.js";
import {
  DAY,
  certificate,
  ec,
  ed25519Hex,
  keyDescription,
  tpmBundle,
  tpmMaker,
  tpmQuote,
  vendor,
  type CertSpec,
  type DescriptionSpec,
} from "./attestation-fixture.js";

/**
 * ── Attestation chains, made in attestation-fixture and put to the verifier ──
 *
 * No phone was available, so the chains are built byte by byte in the shape
 * Android's Keystore produces. They exercise every check and every way each
 * one fails. What they cannot show is that a chain off a real handset parses;
 * that has not been tried and RUNNING.md says so.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");

const google = vendor("Test hardware", NOW);

interface Enrolment {
  input: AttestationInput;
  pubkeyHex: string;
}

/** A phone's enrolment: a fresh Ed25519 key, a challenge, and the chain over them. */
function enrolment(
  over: Partial<DescriptionSpec> & { leaf?: Partial<CertSpec>; chain?: (leaf: Buffer) => Buffer[] } = {},
): Enrolment {
  const key = generateKeyPairSync("ed25519");
  const pubkeyHex = ed25519Hex(key.publicKey);
  const challenge = randomBytes(32);
  const { leaf: leafOver, chain, ...description } = over;
  const leaf = certificate({
    subject: "Android Keystore Key",
    issuer: "Test hardware intermediate",
    subjectKey: key.publicKey,
    signerKey: google.mid.privateKey,
    serial: 424242,
    now: NOW,
    keyDescription: keyDescription({ challenge, ...description }),
    ...leafOver,
  });
  const certs = chain ? chain(leaf) : [leaf, google.midCert, google.rootCert];
  return {
    pubkeyHex,
    input: {
      attestation: new Uint8Array(Buffer.concat(certs)),
      pubkeyHex,
      expectedChallenge: challenge,
      roots: [google.x509],
      now: NOW,
    },
  };
}

const failed = (r: AttestationRuling) => r.checks.filter((c) => c.passed === false).map((c) => c.check);
const check = (r: AttestationRuling, name: string) => r.checks.find((c) => c.check === name);

test("a chain from secure hardware, over the enrolled key and this ledger's challenge, is verified", () => {
  const r = verifyAttestation(enrolment().input);
  assert.equal(r.outcome, "verified", JSON.stringify(failed(r)));
  assert.deepEqual(r.checks.map((c) => c.check), [...ATTESTATION_CHECKS]);
  assert.equal(r.facts.attestationSecurityLevel, "TrustedEnvironment");
  assert.equal(r.facts.verifiedBootState, "Verified");
  assert.equal(r.facts.deviceLocked, true);
  assert.equal(r.facts.certificates, 3);
});

test("the revocation check is not evaluated without a list, and that is not a pass", () => {
  const r = verifyAttestation(enrolment().input);
  assert.equal(check(r, "not_revoked")?.passed, undefined);
  assert.match(check(r, "not_revoked")?.evidence ?? "", /^not evaluated/);
});

test("nothing presented is absent, not verified and not refused", () => {
  const r = verifyAttestation({ ...enrolment().input, attestation: undefined });
  assert.equal(r.outcome, "absent");
  assert.equal(r.checks.length, 0);
});

test("a PEM bundle is read the same as concatenated DER", () => {
  const e = enrolment();
  const pem = new X509Certificate(Buffer.from(e.input.attestation!).subarray(0, readTlv(e.input.attestation!).next))
    .toString() + new X509Certificate(google.midCert).toString() + google.x509.toString();
  const r = verifyAttestation({ ...e.input, attestation: new Uint8Array(Buffer.from(pem)) });
  assert.equal(r.outcome, "verified", JSON.stringify(failed(r)));
});

test("bytes that are not a chain are refused, and every other check says it was not run", () => {
  const r = verifyAttestation({ ...enrolment().input, attestation: new Uint8Array(randomBytes(200)) });
  assert.equal(r.outcome, "refused");
  assert.deepEqual(failed(r), ["chain_readable"]);
  assert.equal(r.checks.length, ATTESTATION_CHECKS.length);
  assert.ok(r.checks.slice(1).every((c) => c.passed === undefined && c.evidence.startsWith("not evaluated")));
});

test("a single self-made certificate is not a chain", () => {
  const e = enrolment({ chain: (leaf) => [leaf] });
  const r = verifyAttestation(e.input);
  assert.deepEqual(failed(r), ["chain_readable"]);
});

test("a chain that ends at a root nobody configured is refused", () => {
  const other = vendor("Somebody else's", NOW);
  const key = generateKeyPairSync("ed25519");
  const e = enrolment({
    leaf: { issuer: "Somebody else's intermediate", signerKey: other.mid.privateKey, subjectKey: key.publicKey },
    chain: (leaf) => [leaf, other.midCert, other.rootCert],
  });
  const r = verifyAttestation(e.input);
  assert.equal(r.outcome, "refused");
  assert.ok(failed(r).includes("root_trusted"));
});

test("with no roots configured, nothing is trusted", () => {
  const r = verifyAttestation({ ...enrolment().input, roots: [] });
  assert.equal(r.outcome, "refused");
  assert.deepEqual(failed(r), ["root_trusted"]);
  assert.match(check(r, "root_trusted")?.evidence ?? "", /no trusted root is configured/);
});

test("a leaf signed by a key that only borrows the intermediate's name breaks the chain", () => {
  const impostor = ec();
  const r = verifyAttestation(enrolment({ leaf: { signerKey: impostor.privateKey } }).input);
  assert.equal(r.outcome, "refused");
  assert.deepEqual(failed(r), ["chain_links"]);
});

test("an expired leaf is refused as out of date", () => {
  const r = verifyAttestation(
    enrolment({ leaf: { notBefore: new Date(NOW.getTime() - 30 * DAY), notAfter: new Date(NOW.getTime() - DAY) } }).input,
  );
  assert.deepEqual(failed(r), ["chain_in_date"]);
});

test("an attestation answering some other challenge is refused", () => {
  const e = enrolment();
  const r = verifyAttestation({ ...e.input, expectedChallenge: randomBytes(32) });
  assert.deepEqual(failed(r), ["challenge_fresh"]);
});

test("an attestation with no challenge outstanding is refused: it could be from any time", () => {
  const r = verifyAttestation({ ...enrolment().input, expectedChallenge: null });
  assert.deepEqual(failed(r), ["challenge_fresh"]);
});

test("a genuine attestation for a different key does not enrol this one", () => {
  const e = enrolment();
  const r = verifyAttestation({ ...e.input, pubkeyHex: "ab".repeat(32) });
  assert.deepEqual(failed(r), ["key_is_enrolled_key"]);
});

test("a key held in software is refused", () => {
  const r = verifyAttestation(enrolment({ attestationLevel: 0, keyMintLevel: 0 }).input);
  assert.deepEqual(failed(r), ["hardware_backed"]);
  assert.equal(r.facts.keyMintSecurityLevel, "Software");
});

test("StrongBox counts as hardware", () => {
  const r = verifyAttestation(enrolment({ attestationLevel: 2, keyMintLevel: 2 }).input);
  assert.equal(r.outcome, "verified");
  assert.equal(r.facts.attestationSecurityLevel, "StrongBox");
});

test("an unlocked bootloader is refused", () => {
  const r = verifyAttestation(enrolment({ deviceLocked: false, bootState: 2 }).input);
  assert.deepEqual(failed(r), ["boot_verified"]);
  assert.match(check(r, "boot_verified")?.evidence ?? "", /unlocked.*Unverified/);
});

test("a locked phone running a self-signed system is refused", () => {
  const r = verifyAttestation(enrolment({ bootState: 1 }).input);
  assert.deepEqual(failed(r), ["boot_verified"]);
});

test("a boot state the software wrote, not the hardware, counts for nothing", () => {
  const r = verifyAttestation(enrolment({ rootOfTrustInSoftware: true }).input);
  assert.deepEqual(failed(r), ["boot_verified"]);
});

test("a leaf with no key description is refused, and the checks that read it say they were not run", () => {
  const key = generateKeyPairSync("ed25519");
  const bare = certificate({
    subject: "No description", issuer: "Test hardware intermediate", subjectKey: key.publicKey,
    signerKey: google.mid.privateKey, now: NOW,
  });
  const r = verifyAttestation({
    attestation: new Uint8Array(Buffer.concat([bare, google.midCert, google.rootCert])),
    pubkeyHex: ed25519Hex(key.publicKey),
    expectedChallenge: randomBytes(32),
    roots: [google.x509],
    now: NOW,
  });
  assert.deepEqual(failed(r), ["key_description"]);
  for (const n of ["hardware_backed", "challenge_fresh", "boot_verified"]) {
    assert.equal(check(r, n)?.passed, undefined, n);
  }
});

test("a revoked intermediate refuses the chain, and a clean list passes it", () => {
  const e = enrolment();
  const revoked = verifyAttestation({ ...e.input, revocation: (s) => (parseInt(s, 16) === 7001 ? "REVOKED" : undefined) });
  assert.deepEqual(failed(revoked), ["not_revoked"]);
  assert.match(check(revoked, "not_revoked")?.evidence ?? "", /certificate 2 is listed as REVOKED/);
  const clean = verifyAttestation({ ...e.input, revocation: () => undefined });
  assert.equal(clean.outcome, "verified");
  assert.equal(check(clean, "not_revoked")?.passed, true);
});

test("everything wrong at once is all reported, not just the first", () => {
  const e = enrolment({ attestationLevel: 0, keyMintLevel: 0, deviceLocked: false, bootState: 3 });
  const r = verifyAttestation({ ...e.input, expectedChallenge: randomBytes(32), pubkeyHex: "cd".repeat(32), roots: [] });
  assert.deepEqual(failed(r), ["root_trusted", "hardware_backed", "challenge_fresh", "key_is_enrolled_key", "boot_verified"]);
});

test("the reader refuses truncated and indefinite-length data rather than guessing", () => {
  assert.throws(() => readTlv(new Uint8Array([0x30, 0x05, 0x01])), DerError);
  assert.throws(() => readTlv(new Uint8Array([0x30, 0x80, 0x00, 0x00])), DerError);
  assert.throws(() => certificateExtension(new Uint8Array([0x04, 0x01, 0x00]), "1.2.3"), DerError);
});

test("a challenge is answered once and expires", () => {
  const book = new ChallengeBook();
  const c = randomBytes(32);
  book.issue("aa", c, NOW);
  assert.deepEqual(book.take("aa", NOW), c);
  assert.equal(book.take("aa", NOW), null);
  book.issue("bb", c, NOW);
  assert.equal(book.take("bb", new Date(NOW.getTime() + 11 * 60_000)), null);
});

// ── a centre PC: a TPM vouching for a key it does not hold ──

const tpm = tpmMaker("Test TPM", NOW);

function pcEnrolment(over: { quote?: Partial<Parameters<typeof tpmQuote>[0]>; bundle?: Parameters<typeof tpmBundle>[2] } = {}) {
  const key = generateKeyPairSync("ed25519");
  const pubkeyHex = ed25519Hex(key.publicKey);
  const challenge = randomBytes(32);
  const quoted = tpmQuote({ extraData: tpmBinding(challenge, pubkeyHex), ...over.quote });
  const input: AttestationInput = {
    attestation: tpmBundle(tpm, quoted, over.bundle),
    pubkeyHex,
    expectedChallenge: challenge,
    roots: [google.x509],
    tpmRoots: [tpm.x509],
    now: NOW,
  };
  return { input, pubkeyHex, challenge };
}

test("a quote from a certified attestation key, naming the enrolled key and the challenge, is verified", () => {
  const r = verifyAttestation(pcEnrolment().input);
  assert.equal(r.outcome, "verified", JSON.stringify(failed(r)));
  assert.deepEqual(r.checks.map((c) => c.check), [...TPM_ATTESTATION_CHECKS]);
  assert.equal(r.facts.kind, "tpm-quote");
  assert.equal(r.facts.tpmResetCount, 7);
});

test("a verified TPM quote still says the key is in software, not in the TPM", () => {
  const r = verifyAttestation(pcEnrolment().input);
  assert.match(r.facts.keyHeldIn ?? "", /software.*does not hold it/);
  assert.equal(r.facts.keyMintSecurityLevel, undefined);
});

test("the boot measurement is reported as not evaluated, not as passed", () => {
  const r = verifyAttestation(pcEnrolment().input);
  assert.equal(check(r, "boot_measured")?.passed, undefined);
  assert.match(check(r, "boot_measured")?.evidence ?? "", /^not evaluated/);
});

test("a TPM chain is not trusted because a phone maker's root is configured", () => {
  const r = verifyAttestation({ ...pcEnrolment().input, tpmRoots: [], roots: [google.x509, tpm.x509] });
  assert.deepEqual(failed(r), ["root_trusted"]);
});

test("a quote naming a different key does not enrol this one", () => {
  const e = pcEnrolment();
  const r = verifyAttestation({ ...e.input, pubkeyHex: "ab".repeat(32) });
  assert.deepEqual(failed(r), ["binding_fresh"]);
});

test("a quote made for another challenge, or with none outstanding, is refused", () => {
  const e = pcEnrolment();
  assert.deepEqual(failed(verifyAttestation({ ...e.input, expectedChallenge: randomBytes(32) })), ["binding_fresh"]);
  assert.deepEqual(failed(verifyAttestation({ ...e.input, expectedChallenge: null })), ["binding_fresh"]);
});

test("a quote signed by a key other than the certified attestation key is refused", () => {
  const r = verifyAttestation(pcEnrolment({ bundle: { signerKey: ec().privateKey } }).input);
  assert.deepEqual(failed(r), ["quote_signed"]);
});

test("a certificate not issued as an attestation key certificate is refused, however good its chain", () => {
  const plain = certificate({
    subject: "Test TPM some other key", issuer: "Test TPM intermediate", subjectKey: tpm.ak.publicKey,
    signerKey: tpm.mid.privateKey, now: NOW,
  });
  const r = verifyAttestation(pcEnrolment({ bundle: { akCert: plain } }).input);
  assert.deepEqual(failed(r), ["ak_certificate"]);
});

test("bytes the attestation key signed that a TPM did not generate are refused", () => {
  const notGenerated = verifyAttestation(pcEnrolment({ quote: { magic: 0x12345678 } }).input);
  assert.deepEqual(failed(notGenerated), ["quote_structure"]);
  assert.equal(check(notGenerated, "binding_fresh")?.passed, undefined);
  const notQuote = verifyAttestation(pcEnrolment({ quote: { type: 0x8017 } }).input);
  assert.deepEqual(failed(notQuote), ["quote_structure"]);
});

test("a bundle of an unknown format is refused and every other check says it was not run", () => {
  const r = verifyAttestation(pcEnrolment({ bundle: { format: "tpm2-quote-v9" } }).input);
  assert.deepEqual(failed(r), ["bundle_readable"]);
  assert.equal(r.checks.length, TPM_ATTESTATION_CHECKS.length);
  assert.ok(r.checks.slice(1).every((c) => c.passed === undefined));
  assert.match(r.facts.keyHeldIn ?? "", /software/);
});

test("a truncated quote is refused rather than read past its end", () => {
  const e = pcEnrolment();
  const bundle = JSON.parse(Buffer.from(e.input.attestation!).toString()) as { quoted: string };
  const short = Buffer.from(bundle.quoted, "base64").subarray(0, 20);
  const r = verifyAttestation({ ...e.input, attestation: tpmBundle(tpm, short) });
  assert.deepEqual(failed(r), ["quote_structure"]);
});
