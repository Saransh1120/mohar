# 11 — Verified dependencies and constants

Every value here was fetched from the authoritative source rather than recalled.
Re-verify before a production deployment; the check command is given for each.

## drand quicknet (timelock beacon)

Fetched from `https://api.drand.sh/v2/beacons/quicknet/info`:

```json
{
  "public_key": "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  "period": 3,
  "genesis_time": 1692803367,
  "hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  "groupHash": "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  "schemeID": "bls-unchained-g1-rfc9380",
  "metadata": { "beaconID": "quicknet" }
}
```

**Critical:** quicknet is the *only* mainnet drand chain that supports timelock
encryption. It is unchained with signatures on G1, which is what makes a future
round's signature predictable enough to encrypt against. The other two chains
returned by `/v2/chains` (`8990e7a9…` default mainnet, `04f1e906…`) are chained
and **cannot** be used for tlock.

Round arithmetic, derived from the values above:

```
roundAt(t)      = floor((t - 1692803367) / 3) + 1
timeOfRound(r)  = 1692803367 + (r - 1) * 3
```

Round 1 is emitted at genesis. A 3-second period means the granularity of our
time lock is 3 seconds, which is far finer than the minute-level precision an
exam start time needs.

**Verify:** `curl -s https://api.drand.sh/v2/beacons/quicknet/info`

## Library choices

| Need | Package | Why this one |
| --- | --- | --- |
| Timelock encryption | `tlock-js` + `drand-client` | Written and maintained by the drand team. API: `timelockEncrypt`, `timelockDecrypt`, `roundForTime`, `timeForRound`. |
| Shamir secret sharing | `shamir-secret-sharing` (Privy) | Zero-dependency TypeScript over GF(2^8), operates on `Uint8Array`. **Independently audited by Cure53 and Zellic** — the only JS Shamir implementation with a public audit trail. |
| Canonical serialisation | `canonicalize` | Implements RFC 8785 JSON Canonicalization Scheme. Signatures must be over a byte-exact form; inventing our own ordering would be an unforced correctness risk. |
| Hashing / Ed25519 | `@noble/hashes`, `@noble/curves` | Audited, zero-dependency, and used by most of the ecosystem. |
| Symmetric encryption | `@noble/ciphers` (`xchacha20poly1305`) | XChaCha20's 192-bit nonce means random nonces never collide in practice, which matters because our bundles are encrypted by many workers. |
| Password KDF | `@node-rs/argon2` | Argon2id bindings; the reference KDF for wrapping share S1. |
| RFC 3161 timestamping | `pkijs` + `asn1js` | Provides `TimeStampReq` / `TimeStampResp`. No maintained purpose-built TSA client exists for Node, so we build the request from the RFC structures directly. |
| WebAuthn | `@simplewebauthn/server` | Platform-authenticator registration and assertion verification. |
| HTTP | `fastify` | Schema-first with JSON Schema validation at the route boundary. |

## Free RFC 3161 timestamp authority

`https://freetsa.org/tsr` — POST `application/timestamp-query`, receive
`application/timestamp-reply`. No account, no billing.

Anchoring is not on the request path; it runs nightly. If the TSA is unreachable
the anchor is retried with the same Merkle root, so an outage delays notarisation
without corrupting the chain.

## Standards followed rather than invented

- **RFC 8785 (JCS)** for the canonical byte form that signatures cover.
- **RFC 6962 §2.1** for the Merkle tree: leaves hashed as `SHA256(0x00 || leaf)`
  and internal nodes as `SHA256(0x01 || left || right)`. The domain-separation
  prefixes prevent the second-preimage attack that a naive Merkle tree admits,
  where an internal node can be passed off as a leaf.
- **RFC 3161** for the timestamp token.
- **RFC 9380** hash-to-curve, which is what quicknet's `bls-unchained-g1-rfc9380`
  scheme identifier refers to.

## Deliberately not used

| Rejected | Reason |
| --- | --- |
| `JSON.stringify` for signed payloads | Key order is insertion-dependent; a round-trip through a database or a queue can reorder keys and silently invalidate every signature. |
| A hand-rolled Merkle tree | Second-preimage attacks are easy to introduce and hard to notice. |
| `crypto.randomUUID` for event ordering | UUIDv4 is unordered. Sequence comes from a database `bigserial`; the UUID is only an idempotency key. |
| Any cloud KMS/HSM SDK | Paid. See `adr/0004-no-paid-dependencies.md`. |
