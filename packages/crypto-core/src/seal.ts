import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

/**
 * ── Sealing the paper itself ─────────────────────────────────────────────────
 *
 * Everything else in this package protects the *record* of what happened to a
 * package. This module protects the package's contents: the question paper is
 * encrypted once, at preparation, and the key that opens it is immediately split
 * (see `shamir.ts`) so that no single person can put it back together.
 *
 * ── Why XChaCha20-Poly1305 ──
 *
 * It is an AEAD: one primitive that both encrypts and authenticates, so a
 * ciphertext that has been altered by a single bit fails to open rather than
 * decrypting to plausible-looking rubbish. That property is the whole point
 * here — a paper that decrypts to *something* an hour before an exam, with
 * nobody able to say whether it is the right something, is a worse failure than
 * one that plainly refuses.
 *
 * XChaCha over AES-GCM for one specific reason: the 192-bit nonce is large
 * enough to be generated randomly with no birthday-bound concern. AES-GCM's
 * 96-bit nonce is safe only if you can guarantee it never repeats for a given
 * key, and nonce reuse in GCM is catastrophic — it leaks the authentication key,
 * not merely one message. Sealing happens on ordinary machines, offline, at
 * whatever moment an operator gets to it; a scheme whose safety rests on a
 * counter that must never be replayed is the wrong shape for that.
 *
 * ── Associated data ──
 *
 * The package id is bound in as associated data. It is not secret; binding it
 * means a ciphertext lifted from one package and presented as another fails to
 * open. Without it the sealed bytes are portable between packages and the
 * chain's claim that *this* ciphertext belongs to *this* package rests on
 * bookkeeping alone.
 */

export const SEAL_ALGORITHM = "XChaCha20-Poly1305";
export const CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface SealedContent {
  algorithm: typeof SEAL_ALGORITHM;
  /** Random per seal. Public — it must be kept to decrypt, and reveals nothing. */
  nonceHex: string;
  /** Ciphertext with the Poly1305 tag appended, as produced by the AEAD. */
  ciphertextHex: string;
  /** sha256 of the plaintext. Proves, after opening, that this is what was sealed. */
  contentSha256: string;
  /** sha256 of the ciphertext. What `PACKAGE_SEALED` commits to in the chain. */
  ciphertextSha256: string;
  plaintextBytes: number;
  ciphertextBytes: number;
}

export interface SealResult {
  sealed: SealedContent;
  /** The key that opens it. Split immediately; never persisted whole. */
  contentKey: Uint8Array;
}

/** A fresh 32-byte content key from the platform CSPRNG. */
export function generateContentKey(): Uint8Array {
  return randomBytes(CONTENT_KEY_BYTES);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bind the ciphertext to one package, so it cannot be presented as another. */
const aad = (packageId: string): Uint8Array => enc.encode(`mohar:package:${packageId}`);

/**
 * Encrypt a paper under a fresh nonce.
 *
 * The caller supplies the key so that sealing and splitting happen in one place
 * and the key is never handed back to a second caller who might keep it.
 */
export function sealContent(
  plaintext: string,
  contentKey: Uint8Array,
  packageId: string,
): SealedContent {
  if (contentKey.length !== CONTENT_KEY_BYTES) {
    throw new RangeError(`content key must be ${CONTENT_KEY_BYTES} bytes, got ${contentKey.length}`);
  }
  const plainBytes = enc.encode(plaintext);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(contentKey, nonce, aad(packageId)).encrypt(plainBytes);

  return {
    algorithm: SEAL_ALGORITHM,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ciphertext),
    contentSha256: bytesToHex(sha256(plainBytes)),
    ciphertextSha256: bytesToHex(sha256(ciphertext)),
    plaintextBytes: plainBytes.length,
    ciphertextBytes: ciphertext.length,
  };
}

export class SealOpenError extends Error {
  override readonly name = "SealOpenError";
}

/**
 * Open a sealed paper, and check it is the one that was sealed.
 *
 * Two independent failures are possible and they are reported separately. The
 * AEAD refusing means the key is wrong or the bytes were altered. The AEAD
 * succeeding but the plaintext hash not matching what the chain recorded would
 * mean the *commitment* is wrong — a far stranger condition, and one that must
 * not be reported as if it were a bad key.
 */
export function openSeal(
  sealed: SealedContent,
  contentKey: Uint8Array,
  packageId: string,
): string {
  let plainBytes: Uint8Array;
  try {
    plainBytes = xchacha20poly1305(
      contentKey,
      hexToBytes(sealed.nonceHex),
      aad(packageId),
    ).decrypt(hexToBytes(sealed.ciphertextHex));
  } catch {
    throw new SealOpenError(
      "the sealed content did not authenticate — the key is wrong, the package id does not match, or the ciphertext was altered",
    );
  }

  const digest = bytesToHex(sha256(plainBytes));
  if (digest !== sealed.contentSha256) {
    throw new SealOpenError(
      `content opened but does not match its commitment (expected ${sealed.contentSha256}, got ${digest})`,
    );
  }
  return dec.decode(plainBytes);
}
