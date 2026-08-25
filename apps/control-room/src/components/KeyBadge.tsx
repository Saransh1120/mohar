import type { KeyStatus } from "../lib/api";

/**
 * The key outcome, on every row that has one.
 *
 * The wording is deliberately literal — "never issued", "3 epochs stale" —
 * because the operator's next action differs completely between a key that
 * expired (find the holder, re-issue) and a key that was never issued (find out
 * who made it). A single "invalid key" label would collapse that distinction.
 */
const LABEL: Record<KeyStatus, { text: string; cls: string }> = {
  verified: { text: "key verified", cls: "key-ok" },
  expired: { text: "key expired", cls: "key-bad" },
  unknown: { text: "key never issued", cls: "key-bad" },
  revoked: { text: "key revoked", cls: "key-bad" },
  not_presented: { text: "no key presented", cls: "key-bad" },
  "n/a": { text: "device-signed", cls: "key-na" },
};

export function KeyBadge({
  status,
  fingerprint,
  epochPresented,
  epochCurrent,
}: {
  status: KeyStatus;
  fingerprint?: string | null;
  epochPresented?: number | null;
  epochCurrent?: number | null;
}) {
  const l = LABEL[status];
  const stale =
    status === "expired" && epochPresented != null && epochCurrent != null
      ? epochCurrent - epochPresented
      : null;

  return (
    <span className={`keybadge ${l.cls}`}>
      <span className="keybadge-dot" />
      {l.text}
      {stale ? <span className="keybadge-extra">{stale * 6}h stale</span> : null}
      {fingerprint ? <span className="keybadge-fp">{fingerprint}</span> : null}
    </span>
  );
}
