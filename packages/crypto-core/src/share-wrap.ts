import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * ── Wrapping an official's share to a station ────────────────────────────────
 *
 * When the duty roster is locked, each official's share of the opening key is
 * encrypted to the station that will run the opening. After that the server
 * holds ciphertext it cannot read: the only thing that opens a wrapped share is
 * the station's private unwrap key, which never leaves the station.
 *
 * It is an ordinary ephemeral-static box:
 *
 *     shared  = X25519(ephemeral private, station public)
 *     key     = HKDF-SHA256(shared, salt = ephemeral public ‖ station public,
 *                           info = "MOHAR-SHARE-WRAP-v1" ‖ context)
 *     sealed  = XChaCha20-Poly1305(key, nonce, share, aad = context)
 *
 * `context` names what the share is for - packet, holder, person. It is in the
 * key derivation and in the authenticated data, so a share wrapped for one
 * packet's superintendent cannot be replayed as another packet's, or as the
 * observer's, even to the same station.
 *
 * The station's unwrap key is a key-agreement key, separate from the Ed25519
 * key it signs records with. A key that signs evidence should not also be the
 * key that opens secrets: compromise of one use should not be compromise of
 * both, and a browser can hold each as non-extractable for exactly one purpose.
 */

const DOMAIN = "MOHAR-SHARE-WRAP-v1";

export interface WrapKeypair {
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface WrappedShare {
  ephemeralPublicHex: string;
  nonceHex: string;
  ciphertextHex: string;
}

export class ShareUnwrapError extends Error {
  override readonly name = "ShareUnwrapError";
}

/** A fresh X25519 keypair. A station that can hold keys natively should do that instead. */
export function generateWrapKeypair(): WrapKeypair {
  const priv = x25519.utils.randomPrivateKey();
  return { privateKeyHex: bytesToHex(priv), publicKeyHex: bytesToHex(x25519.getPublicKey(priv)) };
}

function deriveKey(shared: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array, context: string) {
  const salt = new Uint8Array(ephemeralPub.length + recipientPub.length);
  salt.set(ephemeralPub, 0);
  salt.set(recipientPub, ephemeralPub.length);
  return hkdf(sha256, shared, salt, utf8ToBytes(DOMAIN + context), 32);
}

/** Encrypt a share so that only the holder of the recipient's private key can read it. */
export function wrapShare(share: Uint8Array, recipientPublicHex: string, context: string): WrappedShare {
  if (!/^[0-9a-f]{64}$/.test(recipientPublicHex)) {
    throw new RangeError("recipient public key must be 32 bytes of lowercase hex");
  }
  const recipientPub = hexToBytes(recipientPublicHex);
  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const key = deriveKey(x25519.getSharedSecret(ephemeralPriv, recipientPub), ephemeralPub, recipientPub, context);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce, utf8ToBytes(context)).encrypt(share);
  return {
    ephemeralPublicHex: bytesToHex(ephemeralPub),
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ciphertext),
  };
}

/**
 * Open a wrapped share from the X25519 shared secret.
 *
 * Takes the shared secret rather than the private key so that a station whose
 * key is non-extractable can do the key agreement itself (WebCrypto
 * `deriveBits`) and hand over only the result. The private key never has to be
 * readable by the code that calls this.
 */
export function unwrapShareWithSecret(
  wrapped: WrappedShare,
  sharedSecret: Uint8Array,
  recipientPublicHex: string,
  context: string,
): Uint8Array {
  try {
    const key = deriveKey(
      sharedSecret,
      hexToBytes(wrapped.ephemeralPublicHex),
      hexToBytes(recipientPublicHex),
      context,
    );
    return xchacha20poly1305(key, hexToBytes(wrapped.nonceHex), utf8ToBytes(context)).decrypt(
      hexToBytes(wrapped.ciphertextHex),
    );
  } catch {
    // One message for every cause. Which of the key, the context or the bytes
    // was wrong is not something to tell whoever is holding the ciphertext.
    throw new ShareUnwrapError("this share could not be unwrapped with this key for this purpose");
  }
}

/** Open a wrapped share with the recipient's private key in hand. */
export function unwrapShare(
  wrapped: WrappedShare,
  recipientPrivateHex: string,
  context: string,
): Uint8Array {
  const priv = hexToBytes(recipientPrivateHex);
  return unwrapShareWithSecret(
    wrapped,
    x25519.getSharedSecret(priv, hexToBytes(wrapped.ephemeralPublicHex)),
    bytesToHex(x25519.getPublicKey(priv)),
    context,
  );
}

/** What a share is for, as the one string both sides derive the key from. */
export function shareContext(packageId: string, holder: string, personId: string): string {
  return `${packageId}|${holder}|${personId}`;
}
