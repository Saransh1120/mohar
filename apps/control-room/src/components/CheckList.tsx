import type { EngineCheck } from "../lib/api";

/**
 * Every check an engine ran, as it recorded them: green passed, red failed,
 * grey not evaluated. Grey is not green. A check that could not be run is shown
 * as such, with the reason, because a check nobody ran must never look like one
 * that succeeded.
 */
export function CheckList({ checks }: { checks: EngineCheck[] }) {
  return (
    <div>
      {checks.map((c, i) => (
        <div
          key={`${c.check}-${i}`}
          className={`check ${c.passed === true ? "pass" : c.passed === false ? "fail" : "skip"}`}
        >
          <span className="check-name mono">{c.check}</span>
          <span className="check-evidence">{c.evidence}</span>
        </div>
      ))}
    </div>
  );
}

export const roleText = (r: string) => r.replace(/_/g, " ");

export function durationText(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** SHA-256 of a file's bytes, as hex. What a photograph is committed by. */
export async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
