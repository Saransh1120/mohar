import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  answerPrompt,
  dismissDemoRun,
  registerFrameRefresh,
  registerNavigator,
  useDemoRun,
} from "../lib/demoRunner";
import { useEvidence } from "../lib/evidence";

/**
 * The caption the room reads while the one-click run moves between screens,
 * and the opened paper at the end. It also hands the run the router, since the
 * run lives outside any page and has no other way to change screen.
 */
export function DemoRunOverlay() {
  const navigate = useNavigate();
  useEffect(() => {
    registerNavigator((p) => navigate(p));
    return () => registerNavigator(null);
  }, [navigate]);

  const { refreshFrames } = useEvidence();
  useEffect(() => {
    registerFrameRefresh(refreshFrames);
    return () => registerFrameRefresh(null);
  }, [refreshFrames]);

  const run = useDemoRun();
  const [typed, setTyped] = useState("");
  if (!run.screen && !run.paper) return null;

  const submit = (value: string | null) => {
    answerPrompt(value);
    setTyped("");
  };

  const done = run.steps.filter((s) => s.state === "done").length;
  const failed = run.outcome === "failed";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 1001,
        width: "min(760px, calc(100vw - 32px))",
        maxHeight: "70vh",
        overflowY: "auto",
        background: "var(--surface)",
        color: "var(--text)",
        border: `1px solid ${failed ? "var(--critical)" : "var(--border-strong)"}`,
        borderRadius: 10,
        padding: "14px 18px",
        boxShadow: "none",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <strong style={{ fontSize: 16, color: failed ? "var(--critical)" : "var(--text)" }}>
          {run.screen?.title}
        </strong>
        <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap" }}>
          {run.active ? `step ${run.steps.length}` : failed ? "stopped" : "finished"} · {done} done
        </span>
      </div>

      {run.screen?.caption && (
        <div style={{ fontSize: 14.5, lineHeight: 1.45, color: failed ? "var(--critical)" : "var(--text-dim)", wordBreak: "break-word" }}>
          {run.screen.caption}
        </div>
      )}

      {run.prompt && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(typed.trim() || null);
          }}
          style={{ display: "grid", gap: 8, marginTop: 4 }}
        >
          <label htmlFor="judge-key" style={{ fontSize: 15, fontWeight: 600, color: "var(--accent)" }}>
            {run.prompt.question}
          </label>
          <input
            id="judge-key"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={run.prompt.hint}
            style={{
              fontSize: 18,
              padding: "10px 12px",
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--accent)",
              borderRadius: 6,
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => submit(null)}>
              Skip
            </button>
            <button type="submit" className="btn">
              Try this key →
            </button>
          </div>
        </form>
      )}

      {run.paper && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {run.paper}
        </pre>
      )}

      {!run.active && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn" onClick={dismissDemoRun}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
