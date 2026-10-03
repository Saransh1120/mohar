import { useState } from "react";
import { leafHash, verifyInclusion } from "@mohar/crypto-core";

interface Proof {
  day: string;
  index: number;
  treeSize: number;
  chainHash: string;
  leaf: string;
  proof: string[];
  merkleRoot: string;
  tsaToken: string | null;
}

/**
 * What the browser worked out for itself, one finding per line. They are kept
 * apart because they fail for different reasons and mean different things: a
 * proof that does not lead to the served root is a broken record, while a
 * served root that differs from the one the visitor brought is a server
 * showing a different history from the one they were given.
 */
interface Findings {
  /** The leaf is the hash of this event's chain hash. */
  leafMatches: boolean;
  /** The proof path leads from that leaf to the root this server returned. */
  pathLeadsToRoot: boolean;
  /** Null when the visitor supplied no root of their own to compare. */
  rootMatchesSupplied: boolean | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("Malformed proof hash");
  return Uint8Array.from(hex.match(/../g)!.map((part) => parseInt(part, 16)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function PublicVerify() {
  const [id, setId] = useState(new URLSearchParams(location.search).get("event") ?? "");
  const [expectedRoot, setExpectedRoot] = useState("");
  const [result, setResult] = useState<{ proof: Proof; findings: Findings } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      // An ID copied out of a document usually arrives with a space or a line
      // break around it.
      const eventId = id.trim();
      const supplied = expectedRoot.trim().toLowerCase();
      if (!UUID.test(eventId)) throw new Error("Enter an event UUID");
      if (supplied && !/^[0-9a-f]{64}$/.test(supplied)) {
        throw new Error("A Merkle root is 64 hexadecimal characters");
      }
      history.replaceState(null, "", `/verify?event=${encodeURIComponent(eventId)}`);
      const response = await fetch(`/api/verify/inclusion/${encodeURIComponent(eventId)}`);
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Event is unknown or its day has no anchor yet"
            : response.status === 429
              ? `Too many checks from this address. Try again in ${response.headers.get("retry-after") ?? "a few"} seconds`
              : `API returned ${response.status}`,
        );
      }
      const proof = (await response.json()) as Proof;
      const root = bytes(proof.merkleRoot);
      setResult({
        proof,
        findings: {
          leafMatches: equal(leafHash(bytes(proof.chainHash)), bytes(proof.leaf)),
          pathLeadsToRoot: verifyInclusion(bytes(proof.leaf), proof.index, proof.treeSize, proof.proof.map(bytes), root),
          rootMatchesSupplied: supplied ? supplied === proof.merkleRoot : null,
        },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadToken(proof: Proof) {
    if (!proof.tsaToken) return;
    const raw = atob(proof.tsaToken);
    const token = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([token], { type: "application/timestamp-reply" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mohar-${proof.day}.tsr`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const f = result?.findings;
  const included = f ? f.leafMatches && f.pathLeadsToRoot : false;
  const good = "#80d9ca";
  const bad = "#ffafa9";

  return <main style={{ maxWidth: 760, margin: "7vh auto", padding: 24, color: "#e9edf4", fontFamily: "system-ui", lineHeight: 1.5 }}>
    <a href="/" style={{ color: good }}>Mohar</a>
    <h1>Check a custody record</h1>
    <p>Enter its event ID. This page checks the inclusion proof in your browser against the published Merkle root.</p>
    <label style={{ display: "block", marginBottom: 12 }}>Event ID<br />
      <input value={id} onChange={(e) => setId(e.target.value)} placeholder="UUID from the custody record" style={{ width: "100%", padding: 10 }} />
    </label>
    <label style={{ display: "block", marginBottom: 12 }}>Independent Merkle root (optional)<br />
      <input value={expectedRoot} onChange={(e) => setExpectedRoot(e.target.value)} placeholder="Paste a root obtained separately" style={{ width: "100%", padding: 10 }} />
    </label>
    <button onClick={() => void check()} disabled={busy}>{busy ? "Checking…" : "Check record"}</button>
    {error && <p role="alert" style={{ color: bad }}>{error}</p>}
    {result && f && <section style={{ marginTop: 28, border: "1px solid #54606c", borderRadius: 12, padding: 20, overflowWrap: "anywhere" }}>
      <h2 style={{ color: included && f.rootMatchesSupplied !== false ? good : bad }}>
        {!included
          ? "Proof does not verify"
          : f.rootMatchesSupplied === false
            ? "Included in the served root, which is not the root you supplied"
            : "Inclusion proof valid"}
      </h2>
      <ul style={{ paddingLeft: 20 }}>
        <li style={{ color: f.leafMatches ? good : bad }}>
          {f.leafMatches ? "The leaf is the hash of this record's chain hash." : "The leaf is not the hash of this record's chain hash."}
        </li>
        <li style={{ color: f.pathLeadsToRoot ? good : bad }}>
          {f.pathLeadsToRoot
            ? `The proof's ${result.proof.proof.length} step(s) lead from that leaf to the root this server returned.`
            : "The proof does not lead from that leaf to the root this server returned."}
        </li>
        {f.rootMatchesSupplied !== null && <li style={{ color: f.rootMatchesSupplied ? good : bad }}>
          {f.rootMatchesSupplied
            ? "That root is the root you supplied."
            : "That root is not the root you supplied. The server is showing a different root for this day from the one you were given."}
        </li>}
      </ul>
      <p>UTC day: {result.proof.day} · Record {result.proof.index + 1} of {result.proof.treeSize}</p>
      <p>Merkle root: <code>{result.proof.merkleRoot}</code></p>
      <p>Chain hash: <code>{result.proof.chainHash}</code></p>
      {result.proof.tsaToken ? <><p>RFC 3161 timestamp response attached. Verify its signature and CA trust with a trusted RFC 3161 verifier.</p><button onClick={() => downloadToken(result.proof)}>Download timestamp response</button></> : <p>External timestamp pending. This proof establishes inclusion in the served root, but the root has no independently signed time yet.</p>}
      {f.rootMatchesSupplied === null && <p>For independent verification, compare this root with one you obtained through a separate trusted channel.</p>}
    </section>}
  </main>;
}
