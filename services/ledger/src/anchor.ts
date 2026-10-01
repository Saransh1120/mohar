import type { Pool } from "pg";
import { leafHash, merkleRoot, inclusionProof, proofToHex } from "@mohar/crypto-core";
import { bytesToHex } from "@noble/hashes/utils";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TSA_URL = "https://freetsa.org/tsr";
const TSA_CA = fileURLToPath(new URL("../../../infra/tsa/freetsa-root.crt", import.meta.url));
const TSA_CERT = fileURLToPath(new URL("../../../infra/tsa/freetsa-tsa.crt", import.meta.url));

function validUtcDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/** OpenSSL verifies CMS signature, certificate chain, nonce and message imprint. */
export async function requestTimestamp(root: Buffer, tsaUrl: string, caFile: string, tsaCert?: string): Promise<Buffer> {
  if (!tsaUrl.startsWith("https://")) throw new Error("TSA_URL must use HTTPS");
  const dir = await mkdtemp(join(tmpdir(), "mohar-tsa-"));
  const bin = process.env["OPENSSL_BIN"] ?? "openssl";
  const query = join(dir, "request.tsq");
  const response = join(dir, "response.tsr");
  try {
    await execFileAsync(bin, ["ts", "-query", "-digest", root.toString("hex"), "-sha256", "-cert", "-out", query], { timeout: 15_000 });
    const res = await fetch(tsaUrl, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
      body: new Uint8Array(await readFile(query)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`TSA returned HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 2_000_000) throw new Error("TSA response size invalid");
    await writeFile(response, bytes);
    await execFileAsync(bin, ["ts", "-verify", "-queryfile", query, "-in", response, "-CAfile", caFile,
      ...(tsaCert ? ["-untrusted", tsaCert] : [])], { timeout: 15_000 });
    return Buffer.from(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Retry unnotarised roots independently of event append. Never publish an unverified token. */
export async function notariseAnchor(pool: Pool, day: string): Promise<AnchorResult | null> {
  if (!validUtcDay(day)) throw new Error("invalid UTC day");
  const tsaUrl = process.env["TSA_URL"] ?? TSA_URL;
  const caFile = process.env["TSA_CA_FILE"] ?? TSA_CA;
  const tsaCert = process.env["TSA_UNTRUSTED_FILE"] ?? TSA_CERT;
  const anchor = await buildAnchor(pool, day);
  if (!anchor) return null;
  if (anchor.tsaToken) return anchor;
  try {
    const token = await requestTimestamp(Buffer.from(anchor.merkleRoot, "hex"), tsaUrl, caFile, tsaCert);
    const { rowCount } = await pool.query(
      `update led.anchor set tsa_token = $2, published_at = now(), tsa_attempts = tsa_attempts + 1
        where day = $1::date and merkle_root = $3 and tsa_token is null`,
      [day, token, Buffer.from(anchor.merkleRoot, "hex")],
    );
    if (rowCount !== 1) throw new Error("anchor changed during notarisation");
    return { ...anchor, tsaToken: token.toString("base64") };
  } catch (error) {
    await pool.query("update led.anchor set tsa_attempts = tsa_attempts + 1 where day = $1::date and tsa_token is null", [day]);
    throw error;
  }
}

/** Sweep yesterday plus older pending anchors; a TSA outage is retried later. */
export async function sweepAnchors(pool: Pool, log: { warn: (obj: unknown, message: string) => void }): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await buildAnchor(pool, yesterday);
  const { rows } = await pool.query<{ day: string }>(
    `select to_char(day, 'YYYY-MM-DD') as day from led.anchor
      where tsa_token is null and day <= $1::date order by day limit 30`,
    [yesterday],
  );
  for (const row of rows) {
    try {
      await notariseAnchor(pool, row.day);
    } catch (err) {
      log.warn({ day: row.day, err }, "RFC 3161 timestamp attempt failed; will retry");
    }
  }
}

/**
 * Nightly notarisation.
 *
 * Once a day we build a Merkle tree over that day's events, store the root, and
 * ask a free RFC 3161 Timestamp Authority to sign it. The TSA token is what lets
 * a third party — a court, a journalist, an auditor — establish that a given
 * custody record existed, unaltered, at a given time, without trusting us.
 *
 * Two design points worth stating:
 *
 *   1. Anchoring is off the request path. A TSA outage delays notarisation; it
 *      never blocks an append or corrupts the chain. The root is computed and
 *      stored first, the token is fetched after and retried independently.
 *
 *   2. The leaf is the event's *chain* hash, not its body hash. The chain hash
 *      already commits to the event's position, so an inclusion proof proves both
 *      "this happened" and "it happened here in the sequence".
 */

export interface AnchorResult {
  day: string;
  treeSize: number;
  merkleRoot: string;
  firstSeq: string;
  lastSeq: string;
  tsaToken: string | null;
  tsaError?: string;
}

/** Build (or rebuild) the Merkle root for a UTC day and persist it. */
export async function buildAnchor(pool: Pool, day: string): Promise<AnchorResult | null> {
  if (!validUtcDay(day)) throw new Error("invalid UTC day");
  const { rows } = await pool.query<{ seq: string; hash: Buffer }>(
    `select seq, hash
       from led.event
      where received_at >= ($1::date::timestamp at time zone 'UTC')
        and received_at <  (($1::date + 1)::timestamp at time zone 'UTC')
      order by seq asc`,
    [day],
  );

  if (rows.length === 0) return null;

  // Leaves are the stored chain hashes, hashed again with the RFC 6962 leaf
  // prefix. The double hash is not redundant: the 0x00 prefix is what keeps the
  // leaf domain disjoint from the internal-node domain.
  const leaves = rows.map((r) => leafHash(new Uint8Array(r.hash)));
  const root = merkleRoot(leaves);

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;

  const { rows: saved } = await pool.query<{ merkle_root: Buffer; tsa_token: Buffer | null }>(
    "select merkle_root, tsa_token from led.anchor where day = $1::date",
    [day],
  );
  const existing = saved[0];
  if (existing?.tsa_token && !existing.merkle_root.equals(Buffer.from(root))) {
    throw new Error("notarised anchor differs from current event set");
  }
  await pool.query(
    `insert into led.anchor (day, merkle_root, first_seq, last_seq, tree_size)
     values ($1, $2, $3, $4, $5)
     on conflict (day) do update
       set merkle_root = excluded.merkle_root,
           first_seq   = excluded.first_seq,
           last_seq    = excluded.last_seq,
           tree_size   = excluded.tree_size
       where led.anchor.tsa_token is null`,
    [day, Buffer.from(root), first.seq, last.seq, rows.length],
  );

  return {
    day,
    treeSize: rows.length,
    merkleRoot: bytesToHex(root),
    firstSeq: first.seq,
    lastSeq: last.seq,
    tsaToken: existing?.tsa_token?.toString("base64") ?? null,
  };
}

/**
 * Produce an inclusion proof for one event against its day's anchor.
 *
 * This is what `verify-portal` serves. The verifier needs only the leaf, the
 * proof, the tree size, and the published root — not access to the rest of the
 * log, which is the property that makes public verification possible without
 * disclosing every custody record to everyone.
 */
export async function proveInclusion(
  pool: Pool,
  eventId: string,
): Promise<{
  day: string;
  index: number;
  treeSize: number;
  leaf: string;
  chainHash: string;
  proof: string[];
  merkleRoot: string;
  tsaToken: string | null;
} | null> {
  const ev = await pool.query<{ seq: string; hash: Buffer; day: string }>(
    `select seq, hash, to_char(received_at at time zone 'UTC', 'YYYY-MM-DD') as day
       from led.event where id = $1`,
    [eventId],
  );
  const row = ev.rows[0];
  if (!row) return null;

  const anchor = await pool.query<{
    merkle_root: Buffer;
    tree_size: number;
    last_seq: string;
    tsa_token: Buffer | null;
  }>(`select merkle_root, tree_size, last_seq, tsa_token from led.anchor where day = $1::date`, [
    row.day,
  ]);
  const anchorRow = anchor.rows[0];
  if (!anchorRow) return null; // not yet anchored — the caller reports "pending"

  const { rows } = await pool.query<{ seq: string; hash: Buffer }>(
    `select seq, hash
       from led.event
      where received_at >= ($1::date::timestamp at time zone 'UTC')
        and received_at <  (($1::date + 1)::timestamp at time zone 'UTC')
        and seq <= $2::bigint
      order by seq asc`,
    [row.day, anchorRow.last_seq],
  );

  const index = rows.findIndex((r) => r.seq === row.seq);
  if (index < 0) return null;

  const leaves = rows.map((r) => leafHash(new Uint8Array(r.hash)));
  if (rows.length !== anchorRow.tree_size || !Buffer.from(merkleRoot(leaves)).equals(anchorRow.merkle_root)) {
    throw new Error("stored anchor does not match its event range");
  }

  return {
    day: row.day,
    index,
    treeSize: rows.length,
    leaf: bytesToHex(leaves[index]!),
    chainHash: row.hash.toString("hex"),
    proof: proofToHex(inclusionProof(leaves, index)),
    merkleRoot: bytesToHex(anchorRow.merkle_root),
    tsaToken: anchorRow.tsa_token ? anchorRow.tsa_token.toString("base64") : null,
  };
}
