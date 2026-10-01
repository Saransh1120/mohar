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
  const [result, setResult] = useState<{ proof: Proof; valid: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Enter an event UUID");
      const response = await fetch(`/api/verify/inclusion/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(response.status === 404 ? "Event is unknown or its day has no anchor yet" : `API returned ${response.status}`);
      const proof = (await response.json()) as Proof;
      const root = bytes(proof.merkleRoot);
      const valid = equal(leafHash(bytes(proof.chainHash)), bytes(proof.leaf)) &&
        verifyInclusion(bytes(proof.leaf), proof.index, proof.treeSize, proof.proof.map(bytes), root) &&
        (!expectedRoot.trim() || expectedRoot.trim().toLowerCase() === proof.merkleRoot);
      setResult({ proof, valid });
      history.replaceState(null, "", `/verify?event=${encodeURIComponent(id)}`);
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

  return <main style={{ maxWidth: 760, margin: "7vh auto", padding: 24, color: "#e9edf4", fontFamily: "system-ui", lineHeight: 1.5 }}>
    <a href="/" style={{ color: "#80d9ca" }}>Mohar</a>
    <h1>Check a custody record</h1>
    <p>Enter its event ID. This page checks the inclusion proof in your browser against the published Merkle root.</p>
    <label style={{ display: "block", marginBottom: 12 }}>Event ID<br />
      <input value={id} onChange={(e) => setId(e.target.value)} placeholder="UUID from the custody record" style={{ width: "100%", padding: 10 }} />
    </label>
    <label style={{ display: "block", marginBottom: 12 }}>Independent Merkle root (optional)<br />
      <input value={expectedRoot} onChange={(e) => setExpectedRoot(e.target.value)} placeholder="Paste a root obtained separately" style={{ width: "100%", padding: 10 }} />
    </label>
    <button onClick={() => void check()} disabled={busy}>{busy ? "Checking…" : "Check record"}</button>
    {error && <p role="alert" style={{ color: "#ffafa9" }}>{error}</p>}
    {result && <section style={{ marginTop: 28, border: "1px solid #54606c", borderRadius: 12, padding: 20, overflowWrap: "anywhere" }}>
      <h2 style={{ color: result.valid ? "#80d9ca" : "#ffafa9" }}>{result.valid ? "Inclusion proof valid" : "Proof does not verify"}</h2>
      <p>UTC day: {result.proof.day} · Record {result.proof.index + 1} of {result.proof.treeSize}</p>
      <p>Merkle root: <code>{result.proof.merkleRoot}</code></p>
      <p>Chain hash: <code>{result.proof.chainHash}</code></p>
      {result.proof.tsaToken ? <><p>RFC 3161 timestamp response attached. Verify its signature and CA trust with a trusted RFC 3161 verifier.</p><button onClick={() => downloadToken(result.proof)}>Download timestamp response</button></> : <p>External timestamp pending. This proof establishes inclusion in the served root, but the root has no independently signed time yet.</p>}
      {!expectedRoot.trim() && <p>For independent verification, compare this root with one you obtained through a separate trusted channel.</p>}
    </section>}
  </main>;
}
