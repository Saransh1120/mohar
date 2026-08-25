# ADR 0001 - The ledger is not a blockchain

**Status:** accepted

## Context

The custody record must be tamper-evident and admissible in court. "Blockchain"
is the reflexive answer and would be well received by some audiences.

## Decision

A hash-chained append-only Postgres table, with nightly Merkle roots signed and
RFC 3161 timestamped by an external Timestamp Authority, published to a public
verification portal.

## Rationale

- What we need is tamper-evidence plus an independent time anchor, not
  distributed consensus. There is no set of mutually distrusting validators here.
- RFC 3161 tokens are already understood by Indian courts and auditors; a chain
  reorg argument is not.
- Immutability is enforced by database role grants, auditable by a DBA in
  thirty seconds.
- Procurement scepticism: the word invites a category of objection we do not
  need to spend credibility on.

## Consequences

We operate the TSA relationship and the public portal. If a customer requires a
distributed ledger, the anchor step can publish roots to one without changing
anything else.
