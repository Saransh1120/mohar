import { timelockEncrypt, timelockDecrypt } from "tlock-js";
import type { ChainClient, ChainInfo, RandomnessBeacon } from "drand-client";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { QUICKNET, roundAtOrAfter, timeOfRound } from "./drand.js";

/**
 * ── The control room's part, locked to a public clock ────────────────────────
 *
 * The mandatory part of the opening key is encrypted toward a drand quicknet
 * round. Until the league publishes that round's signature, nobody can decrypt
 * it: not the field officers, not the station, not the control room, not us.
 * When the round is published — on schedule, by a network nobody here operates
 * — anyone holding the envelope can open it without asking permission from
 * anything.
 *
 * That property is what lets the ceremony work with the network down. The
 * envelope is issued at T-24h and cached on the station; at T-15 the station
 * needs 48 bytes of beacon signature, which it can take from any public relay,
 * a LAN cache, or an officer's phone. No approval call to headquarters, and
 * nothing at headquarters that could be leaned on to release the key early.
 *
 * ── What this module deliberately does not do ──
 *
 * It does not fetch. Every function here is offline and takes the beacon value
 * as an argument, because the station's copy of this code runs in a room with
 * no route to the internet, and because a library that quietly reaches the
 * network is a library that fails in exactly that room.
 *
 * Encryption uses `tlock-js` (Apache-2.0 OR MIT) against the pinned quicknet
 * parameters in `drand.ts`. Writing our own IBE would be a worse decision than
 * any dependency: this is pairing cryptography where a subtle mistake produces
 * ciphertext that looks fine and opens early.
 */

/**
 * What the envelope is allowed to open.
 *
 * Carried with the ciphertext, hashed into the issuing event, and checked by
 * the station before the assembled key is used. The time lock answers "not
 * yet"; the policy answers "not here, and not by these people".
 */
export interface EnvelopePolicy {
  packageId: string;
  centreId: string;
  roomId: string;
  /** ISO timestamps. The ceremony may run inside this window and nowhere else. */
  windowStart: string;
  windowEnd: string;
  eligibleRoles: readonly string[];
}

export interface ControlEnvelope {
  /** The quicknet round whose signature opens this envelope. */
  round: number;
  chainHash: string;
  /** age-armoured tlock ciphertext. */
  ciphertext: string;
  policy: EnvelopePolicy;
  /** sha256 over the canonical policy, so the issuing event binds the policy. */
  policySha256: string;
  /** sha256 of the ciphertext, for the CONTROL_ENVELOPE_ISSUED event. */
  ciphertextSha256: string;
  /** When that round is expected. Informational: the round is what binds. */
  opensAt: string;
}

export class TimelockError extends Error {
  override readonly name = "TimelockError";
}

/**
 * A ChainClient that never touches the network.
 *
 * `tlock-js` speaks to drand through this interface, so supplying the pinned
 * chain info and, on the way back, one already-published beacon is all it takes
 * to make both directions work in a sealed room. `latest()` throws rather than
 * guessing: nothing here should ever ask "what round is it now" and get an
 * answer invented locally.
 */
function offlineClient(beacon?: RandomnessBeacon): ChainClient {
  const info: ChainInfo = {
    public_key: QUICKNET.publicKey,
    period: QUICKNET.period,
    genesis_time: QUICKNET.genesisTime,
    hash: QUICKNET.chainHash,
    groupHash: "",
    schemeID: QUICKNET.schemeID,
    metadata: { beaconID: QUICKNET.beaconID },
  };
  return {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: QUICKNET.chainHash,
        publicKey: QUICKNET.publicKey,
      },
    },
    chain: () => ({ baseUrl: "offline:quicknet", info: async () => info }),
    latest: async () => {
      throw new TimelockError("the offline chain client has no notion of the latest round");
    },
    get: async (round: number) => {
      if (!beacon) {
        throw new TimelockError("no beacon was supplied; this envelope cannot be opened offline");
      }
      if (beacon.round !== round) {
        throw new TimelockError(
          `envelope needs round ${round}, the beacon supplied is round ${beacon.round}`,
        );
      }
      return beacon;
    },
  };
}

function canonicalPolicy(policy: EnvelopePolicy): string {
  // Sorted keys, no whitespace. The same shape the ledger canonicalises with,
  // kept local so this module has no dependency on the contracts package.
  return JSON.stringify({
    centreId: policy.centreId,
    eligibleRoles: [...policy.eligibleRoles].sort(),
    packageId: policy.packageId,
    roomId: policy.roomId,
    windowEnd: policy.windowEnd,
    windowStart: policy.windowStart,
  });
}

/**
 * Wrap the control room's part so it cannot be read before `opensAt`.
 *
 * The round chosen is the first one at or after that instant, so the envelope
 * never opens early and opens at most one period (3 s) late.
 */
export async function wrapControlPart(
  controlPart: Uint8Array,
  opensAt: Date,
  policy: EnvelopePolicy,
): Promise<ControlEnvelope> {
  if (controlPart.length !== 32) {
    throw new RangeError(`control part must be 32 bytes, got ${controlPart.length}`);
  }
  const round = roundAtOrAfter(opensAt);
  const ciphertext = await timelockEncrypt(
    round,
    Buffer.from(controlPart),
    offlineClient(),
  );
  return {
    round,
    chainHash: QUICKNET.chainHash,
    ciphertext,
    policy,
    policySha256: bytesToHex(sha256(utf8ToBytes(canonicalPolicy(policy)))),
    ciphertextSha256: bytesToHex(sha256(utf8ToBytes(ciphertext))),
    opensAt: timeOfRound(round).toISOString(),
  };
}

/**
 * Open an envelope with the beacon for its round.
 *
 * The beacon's signature is verified against the pinned quicknet public key
 * before it is used, so a station handed a fabricated "round 21000000" by
 * someone on its LAN gets a failure rather than an early key.
 */
export async function unwrapControlPart(
  envelope: ControlEnvelope,
  beacon: { round: number; signature: string },
): Promise<Uint8Array> {
  if (envelope.chainHash !== QUICKNET.chainHash) {
    throw new TimelockError(
      `envelope is bound to chain ${envelope.chainHash}, which is not quicknet`,
    );
  }
  if (beacon.round !== envelope.round) {
    throw new TimelockError(
      `this envelope opens at round ${envelope.round}; the beacon offered is round ${beacon.round}`,
    );
  }
  if (bytesToHex(sha256(utf8ToBytes(envelope.ciphertext))) !== envelope.ciphertextSha256) {
    throw new TimelockError("ciphertext does not match the hash recorded when it was issued");
  }

  // drand-client verifies a beacon by checking both the BLS signature and that
  // the randomness is the hash of that signature. The v2 API no longer returns
  // the randomness field, so it is derived here rather than asked for: it is a
  // function of the signature, and requiring callers to carry it would invite
  // them to carry a wrong one.
  const verifiable = {
    round: beacon.round,
    signature: beacon.signature,
    randomness: bytesToHex(sha256(hexToBytes(beacon.signature))),
  } as unknown as RandomnessBeacon;

  const plaintext = await timelockDecrypt(envelope.ciphertext, offlineClient(verifiable));
  return new Uint8Array(plaintext);
}

/** Recompute the policy hash, for a station checking what it was handed. */
export function policyCommitment(policy: EnvelopePolicy): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalPolicy(policy))));
}

/**
 * Has this envelope's round been published yet?
 *
 * A convenience for a screen that has to say "unlocks in 4 minutes" without
 * pretending it can hurry the beacon along.
 */
export function secondsUntilOpen(envelope: ControlEnvelope, now: Date = new Date()): number {
  const opensAt = timeOfRound(envelope.round).getTime();
  return Math.max(0, Math.ceil((opensAt - now.getTime()) / 1000));
}
