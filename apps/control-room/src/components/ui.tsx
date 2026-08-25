import type { ReactNode } from "react";
import type { PackageState } from "../lib/api";

export function Card({
  title,
  hint,
  actions,
  flush,
  children,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  /*
   * `flush` drops the body padding so a table or a long feed can run edge to
   * edge and its row dividers reach the card border. Padded content — forms,
   * prose, key/value blocks — leaves it off.
   */
  return (
    <div className="card">
      {title && (
        <div className="card-head">
          <h3>
            {title} {hint && <span className="hint">{hint}</span>}
          </h3>
          {actions}
        </div>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </div>
  );
}

/**
 * A stat tile.
 *
 * All four tiles share one flat card. There are no tinted backgrounds: filling a
 * whole panel red makes the tile shout when only its number has changed, and a
 * row of competing washes is exactly what the eye cannot rank.
 *
 * `tone` drives only two things — the numeral's colour and a 2px left edge —
 * which is enough to find across a row and quiet enough to disappear at zero.
 *
 * `caption` is a fragment, not a sentence: a few words in mono that read as an
 * annotation. Anything longer belongs in `detail`, which becomes the tile's
 * tooltip rather than a third line of prose competing with the number.
 */
export function Stat({
  label,
  value,
  caption,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  caption?: string;
  detail?: string;
  tone?: "neutral" | "ok" | "high" | "critical";
}) {
  return (
    <div className="stat" data-tone={tone} {...(detail ? { title: detail } : {})}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {caption && <div className="foot">{caption}</div>}
    </div>
  );
}

export function StateBadge({ state }: { state: PackageState }) {
  return <span className={`badge state ${state}`}>{state.replace(/_/g, " ")}</span>;
}

/**
 * Risk as a bar plus a number.
 *
 * The bar carries the magnitude; the number is there because "how bad, exactly"
 * is the operator's next question and making them hover for it wastes a second
 * that matters.
 */
export function RiskMeter({ score }: { score: number }) {
  const colour =
    score >= 70 ? "var(--critical)" :
    score >= 40 ? "var(--high)" :
    score >= 15 ? "var(--medium)" :
    "var(--ok)";
  return (
    <div className="risk">
      <div className="risk-bar">
        <div className="risk-fill" style={{ width: `${score}%`, background: colour }} />
      </div>
      <span className="risk-num" style={{ color: score > 0 ? colour : "var(--text-faint)" }}>
        {score}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: Error }) {
  return (
    <div className="banner">
      {error.message}
      <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
        Check that the ledger service is running on port 8081.
      </div>
    </div>
  );
}
