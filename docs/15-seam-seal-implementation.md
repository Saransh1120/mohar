# 15 · Seam seal — implementation surface

**Session C** of the two-QR tamper-evident sealing design. Follows `docs/13` and
`docs/14`. Every file below is real; each is marked **implemented** (in the tree
now, builds clean), **designed** (specified, no code) or **not started**.

---

## 1 · Every touched file

| File | Change | Status |
| --- | --- | --- |
| `packages/crypto-core/src/seam.ts` | new module: `generateSeamToken`, `seamCommitment`, `seamCommitmentFromHex`, `seamTokenMatches` | implemented |
| `packages/crypto-core/src/index.ts` | re-exports `seam.js` | implemented |
| `packages/contracts/src/enums.ts` | `DenyReason` gains `seam_token_absent`, `seam_token_mismatch` | implemented |
| `packages/contracts/src/events.ts` | `PackageSealedPayload.seamCommitment?`, `AccessRequestedPayload.seamTokenRead?` | implemented |
| `infra/migrations/005_seam_seal.sql` | `ref.package.seam_commitment char(64)` plus hex constraint | written, **not yet applied** |
| `services/ledger/src/domain/policy.ts` | check `seam_token`, unlock stage only; request field; query column | implemented |
| `services/ledger/src/http/access-routes.ts` | boundary regex on `seamTokenRead` | implemented |
| `apps/control-room/src/lib/api.ts` | `requestAccess` accepts `seamTokenRead` | implemented |
| `services/ledger/src/http/routes.ts` | nothing — `POST /events` already validates payloads through the contracts schema, so `seamCommitment` is checked there for free | no change needed |
| `apps/control-room/src/pages/FailedAttempts.tsx` | nothing — deny reasons are rendered from the ledger's own codes, so the two new reasons appear without a lookup table | no change needed |
| `apps/control-room/src/pages/PackageDetail.tsx` | "Seam seal: fitted / none" row, and the seam panel in the sidebar | implemented |
| `apps/control-room/src/components/SeamSealPanel.tsx` | fit a seal (browser makes the token, sends only the commitment, draws a V2/ECC-L QR once); test a flap code with the laptop camera via `jsQR` | implemented — the browser stands in for `sealkeys` |
| `services/ledger/src/store/registry.ts` | `fitSeamSeal` (set once, 409 on a second fit, 503 before migration 005), `testSeamToken` (read-only), `seamProtected` on package detail | implemented |
| `services/ledger/src/http/registry-routes.ts` | `POST /packages/:id/seam-seal`, `POST /packages/:id/seam-test`, both regex-validated | implemented |
| `apps/control-room/src/pages/LiveDemo.tsx` | seal a demo package with a commitment and present the token at unlock | designed |
| `apps/control-room/src/lib/station.ts` | carry a decoded seam token from the station | not started |
| `services/sealkeys`, `services/render` | generate `s`, commit, print, forget | not started — both are `README.md` and `.gitkeep` |

Nothing in the tree decodes a QR from a camera. The engine accepts a token that
nothing can yet produce.

---

## 2 · Boundary validation — implemented

Two untrusted strings arrive from scanning. Both are validated by shape before
anything else sees them, and neither is ever interpolated into a query, a log
line, or a prompt.

```ts
// services/ledger/src/http/access-routes.ts
seamTokenRead: z
  .string()
  .regex(/^[0-9a-f]{64}$/, "seam token must be 64 lowercase hex characters")
  .optional(),
```

```ts
// packages/contracts/src/events.ts — the same rule inside the signed event
seamTokenRead: z.string().regex(/^[0-9a-f]{64}$/).optional(),
```

The transit code's `rawIdentifier` is already bounded by `ShortText` in
`ScanObservedPayload` (`events.ts:101`). That bounds length, not alphabet. It is
stored as evidence and deliberately never resolved into an authorisation — a
scan of an unknown identifier is recorded because it is itself intelligence.

The regex is the whole validation for the seam token, and that is the point: 64
characters from a 16-character alphabet has no room left in it for anything but
a token. A payload that is not exactly that is rejected with a 400 and never
reaches `decideAccess`.

---

## 3 · The check — implemented

`services/ledger/src/domain/policy.ts`, section 6b. Five outcomes:

| Situation | Passed | Reason code | Effect on the decision |
| --- | --- | --- | --- |
| stage is not `unlock` | no | none | not evaluated — does not refuse |
| package unknown | no | none | not evaluated — other checks refuse |
| package has no commitment | no | none | not evaluated — does not refuse |
| commitment exists, nothing was read | no | `seam_token_absent` | refuses |
| commitment exists, token does not open it | no | `seam_token_mismatch` | refuses |
| token opens the commitment | yes | — | passes |

The engine grants only when the set of reason codes is empty
(`policy.ts`, `denyReasons.length === 0`). A check that fails *without* a reason
code is a check that was not evaluated. That is how the three unfitted checks
already behave, and the seam check follows the same rule, so a package sealed
before the seam label existed is never refused for lacking one.

`seam_token_absent` refuses. `docs/13 §8` says an unreadable seam should route to
a witnessed manual ceremony rather than a dead end. That routing is the
`FALLBACK_INVOKED` path, which is service-only (`events.ts:65`) — the station
reports, the service decides. The refusal is correct as the engine's answer; the
fallback is what an operator does next, and it is not automated.

---

## 4 · F6 — where an LLM may and may not sit

Nothing in this design calls a language model, and the rule is that nothing ever
may in the verification path. Stated precisely:

| Point | Permitted | Why |
| --- | --- | --- |
| Writing code, tests, ADRs, these documents | yes | build time; a human reviews and commits |
| Explaining a denial the ledger has **already** recorded, in plain language | yes | read-only over a decided outcome; the explanation changes nothing |
| Parsing, cleaning or interpreting a scanned payload | **no** | a QR is attacker-controlled text; routing it into a model with tools builds an injection channel into a custody chain |
| Any input to `decideAccess` | **no** | a decision must be reproducible from its inputs; model output is not |

The boundary regex in §2 is what makes the third row safe regardless: a string
that survived it cannot carry an instruction.

---

## 5 · F9 — the browser signing gap

The control room can sign events as a centre device. `lib/witness.ts` generates an
Ed25519 key and keeps the private half in `localStorage` — unattested, not bound
to a TPM, readable by anything running in that browser profile. The file says so
itself, and `lib/api.ts` still carries the older claim that the browser never
constructs a signed event. Both are true of different parts of the app.

A QR scanner built into the control room would inherit that weakness exactly: a
seam token read in the browser is only as trustworthy as the browser's key. So:

- **Preferred:** the seam code is read by the ESP32 station, which signs with a
  key in its own flash.
- **If the browser scans:** the resulting request must be recorded as having come
  from the centre PC, and the trust that implies must be stated wherever it is
  shown — not smoothed over.

The station path is not built (§1, `station.ts`).

---

## 6 · To make it live

In order, because each depends on the one before:

1. Apply `005_seam_seal.sql` as `mohar_migrator`.
2. Build issuance in `sealkeys`: generate `s`, write `seamCommitment` into
   `PACKAGE_SEALED`, project it into `ref.package.seam_commitment`.
3. Build `render` to print the label to the `docs/13 §6` specification.
4. Add a QR decode to the station, and `seamTokenRead` to `station.ts`.
5. Surface commitment status on `PackageDetail.tsx`.
