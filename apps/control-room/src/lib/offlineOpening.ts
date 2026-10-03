import {
  combineOpeningKey,
  combineSeamShares,
  seamLabelMatches,
  unwrapControlPart,
  type ControlEnvelope,
  type FieldShare,
} from "@mohar/crypto-core";
import type { EngineCheck, OfflineTranscript, StationCache } from "./api";
import { fetchBeacon, unwrapOfficialShare, type Station } from "./openingStation";

/**
 * ── The station on its own ───────────────────────────────────────────────────
 *
 * What a station does to open a packet when it cannot reach the ledger. It
 * works from a cache it fetched while the link was up: the time-locked
 * envelope, the three wrapped shares, and what to check a scan, a finger and a
 * serial against.
 *
 * Two things about this path are different in kind from the live one, and the
 * page that uses this says both.
 *
 * The checks here are the station's. On the live path the ledger identifies
 * each official before it hands over their share; here the station already
 * holds all three, so that two officials stood at the reader is enforced by
 * this code and reported afterwards. A station that skipped the checks could
 * still open the packet. What it could not do is make the report pass: the
 * ledger puts the same steps to the same checks when it is told.
 *
 * The time lock is not the station's. The envelope opens with the value of a
 * drand round and with nothing else, so "the ledger is out of reach" never
 * means "the packet can be opened early". The round still has to come from
 * somewhere - a public relay, a LAN cache, an officer's phone - and here it is
 * fetched from a relay.
 */

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

/** Both fingers inside this many seconds. The ledger applies the same limit. */
const TWO_OFFICIAL_WINDOW_S = 120;
const MIN_BIOMETRIC_SCORE = 60;

export interface PresentedOfficial {
  personId: string;
  biometricSlot?: number;
  biometricScore?: number;
  assertedAt: string;
}

export interface OfflineInput {
  /** Both halves of the label as scanned, or absent if it was not scanned. */
  label?: { seamId: string; shareAHex: string; shareBHex: string };
  officials: PresentedOfficial[];
  packetSerialTyped: string;
}

/** The station's own ruling on what was presented to it. Pure. */
export function stationChecks(cache: StationCache, input: OfflineInput, now: Date): EngineCheck[] {
  const checks: EngineCheck[] = [];
  const add = (check: string, passed: boolean | undefined, evidence: string) =>
    checks.push({ check, evidence, ...(passed === undefined ? {} : { passed }) });

  // ── the seal ──
  if (!cache.seam) {
    add("seam_commitment", false, "the cache holds no seam commitment to check a scan against");
  } else if (!input.label) {
    add("seam_commitment", false, "both codes must be scanned; no label was presented");
  } else {
    const secret = combineSeamShares(fromHex(input.label.shareAHex), fromHex(input.label.shareBHex));
    const matches =
      input.label.seamId === cache.seam.seamId &&
      seamLabelMatches(cache.seam.seamId, secret, cache.seam.commitmentHex);
    add(
      "seam_commitment",
      matches,
      matches
        ? `label ${cache.seam.seamId} matches the commitment in the cache; the seal is intact`
        : `scanned label ${input.label.seamId} does not match the commitment cached for ${cache.seam.seamId}`,
    );
  }

  // ── when ──
  const from = Date.parse(cache.examStartsAt) - 30 * 60_000;
  const inWindow = now.getTime() >= from && now.getTime() <= Date.parse(cache.examStartsAt);
  add(
    "ceremony_window",
    inWindow,
    inWindow
      ? "inside the thirty minutes before the exam"
      : "outside the thirty minutes before the exam; the station does not begin",
  );

  // ── who ──
  const known = input.officials.map((o) => cache.officials.find((c) => c.personId === o.personId));
  add(
    "two_officials",
    input.officials.length === 2 && new Set(input.officials.map((o) => o.personId)).size === 2,
    `${input.officials.length} official${input.officials.length === 1 ? "" : "s"} presented; the opening takes two different people`,
  );
  add(
    "on_cached_roster",
    input.officials.length > 0 && known.every(Boolean),
    known.every(Boolean)
      ? known.map((k) => `${k!.name} (${k!.holder.replace(/_/g, " ")})`).join(" and ")
      : "someone presented is not on the roster this station cached",
  );
  const slotsOk = input.officials.every((o, i) => known[i]?.slot != null && known[i]?.slot === o.biometricSlot);
  add(
    "slots_registered",
    input.officials.length > 0 ? slotsOk : undefined,
    slotsOk
      ? "each finger matched the slot registered to the official named"
      : "a finger was not presented, or matched a slot that is not that official's",
  );
  const scoresOk = input.officials.every((o) => (o.biometricScore ?? 0) >= MIN_BIOMETRIC_SCORE);
  add(
    "biometric_scores",
    input.officials.length > 0 ? scoresOk : undefined,
    input.officials.map((o) => `score ${o.biometricScore ?? "none"}`).join("; ") + ` (minimum ${MIN_BIOMETRIC_SCORE})`,
  );
  if (known.length === 2 && known[0] && known[1]) {
    const differ = known[0].institution.toLowerCase() !== known[1].institution.toLowerCase();
    add("different_institution", differ, `${known[0].institution} and ${known[1].institution}`);
    const [a, b] = input.officials.map((o) => Date.parse(o.assertedAt)) as [number, number];
    const seconds = Math.abs(a - b) / 1000;
    add(
      "two_person_window",
      seconds <= TWO_OFFICIAL_WINDOW_S,
      `${Math.round(seconds)}s between the two fingers (limit ${TWO_OFFICIAL_WINDOW_S}s)`,
    );
  } else {
    add("different_institution", undefined, "not evaluated: there are not two officials on the cached roster");
    add("two_person_window", undefined, "not evaluated: there are not two officials on the cached roster");
  }

  // ── the serial ──
  const typed = input.packetSerialTyped.trim().toUpperCase();
  const registered = cache.packetSerial?.trim().toUpperCase() ?? null;
  add(
    "packet_serial",
    registered === null ? undefined : typed === registered,
    registered === null ? "not evaluated: the cache holds no serial" : `typed ${typed}; cached ${registered}`,
  );

  return checks;
}

/**
 * Open the envelope with the published round and assemble the key from two
 * cached shares. Which two is the caller's choice; a station following the
 * procedure passes the two officials it identified.
 */
export async function assembleFromCache(
  station: Station,
  cache: StationCache,
  holderIds: readonly string[],
): Promise<string> {
  const env = cache.envelope as ControlEnvelope;
  const beacon = await fetchBeacon(env.round);
  const controlPart = await unwrapControlPart(env, beacon);
  const shares: FieldShare[] = [];
  for (const o of cache.officials.filter((x) => holderIds.includes(x.personId))) {
    shares.push(
      await unwrapOfficialShare(station, cache.packageId, {
        outcome: "passed",
        denyReasons: [],
        checks: [],
        identified: shares.length + 1,
        official: { personId: o.personId, role: o.holder, institution: o.institution },
        share: {
          wrapped: o.wrapped,
          holder: o.holder,
          institution: o.institution,
          index: o.index,
          commitment: o.commitment,
        },
      }),
    );
  }
  const key = await combineOpeningKey(controlPart, shares, cache.commitments);
  for (const s of shares) s.share.fill(0);
  return toHex(key);
}

/** The station's account of what it did, for the ledger. */
export function buildTranscript(
  station: Station,
  cache: StationCache,
  input: OfflineInput,
  openingKeyHex: string,
  startedAt: string,
  photoSha256?: string,
): OfflineTranscript {
  const seam = input.label
    ? {
        seamIdRead: input.label.seamId,
        seamSecretHex: toHex(
          combineSeamShares(fromHex(input.label.shareAHex), fromHex(input.label.shareBHex)),
        ),
      }
    : {};
  return {
    transcriptId: crypto.randomUUID(),
    packageId: cache.packageId,
    deviceId: station.deviceId,
    ...seam,
    officials: input.officials,
    packetSerialTyped: input.packetSerialTyped,
    openingKeyHex,
    ...(photoSha256 ? { photoSha256 } : {}),
    startedAt,
    releasedAt: new Date().toISOString(),
  };
}
