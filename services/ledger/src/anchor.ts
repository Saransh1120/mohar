import type { Pool } from "pg";
import { leafHash, merkleRoot, inclusionProof, proofToHex } from "@mohar/crypto-core";
import { bytesToHex } from "@noble/hashes/utils";

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
  const { rows } = await pool.query<{ seq: string; hash: Buffer }>(
    `select seq, hash
       from led.event
      where received_at >= $1::date
        and received_at <  ($1::date + interval '1 day')
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

  await pool.query(
    `insert into led.anchor (day, merkle_root, first_seq, last_seq, tree_size)
     values ($1, $2, $3, $4, $5)
     on conflict (day) do update
       set merkle_root = excluded.merkle_root,
           first_seq   = excluded.first_seq,
           last_seq    = excluded.last_seq,
           tree_size   = excluded.tree_size`,
    [day, Buffer.from(root), first.seq, last.seq, rows.length],
  );

  return {
    day,
    treeSize: rows.length,
    merkleRoot: bytesToHex(root),
    firstSeq: first.seq,
    lastSeq: last.seq,
    tsaToken: null,
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
    tsa_token: Buffer | null;
  }>(`select merkle_root, tree_size, tsa_token from led.anchor where day = $1::date`, [
    row.day,
  ]);
  const anchorRow = anchor.rows[0];
  if (!anchorRow) return null; // not yet anchored — the caller reports "pending"

  const { rows } = await pool.query<{ seq: string; hash: Buffer }>(
    `select seq, hash
       from led.event
      where received_at >= $1::date
        and received_at <  ($1::date + interval '1 day')
      order by seq asc`,
    [row.day],
  );

  const index = rows.findIndex((r) => r.seq === row.seq);
  if (index < 0) return null;

  const leaves = rows.map((r) => leafHash(new Uint8Array(r.hash)));

  return {
    day: row.day,
    index,
    treeSize: rows.length,
    leaf: bytesToHex(leaves[index]!),
    proof: proofToHex(inclusionProof(leaves, index)),
    merkleRoot: bytesToHex(anchorRow.merkle_root),
    tsaToken: anchorRow.tsa_token ? anchorRow.tsa_token.toString("base64") : null,
  };
}
