import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * ── A guided walk through every screen ───────────────────────────────────────
 *
 * After the one-click run, the records it wrote are sitting in every part of
 * the control room — the package's workflow, the activity ledger, the refused
 * attempts, the chain. This walks the audience through each screen in turn,
 * with one line saying what to look at, so the presenter does not have to
 * click through eleven pages while also explaining them.
 *
 * It only navigates. It does not click anything on the pages it visits and it
 * does not decide anything; each screen shows exactly what it would show if
 * someone had opened it by hand. Touching the sidebar hands control back.
 */

const EVENT = "mohar:tour";
const SECONDS = 6;

export function startTour(packageId?: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { packageId } }));
}

interface Stop {
  path: string;
  title: string;
  caption: string;
}

function plan(packageId?: string): Stop[] {
  return [
    {
      path: "/overview",
      title: "Overview",
      caption: "The whole operation at a glance — packages, refusals, and anything nobody has resolved.",
    },
    {
      path: packageId ? `/workflow/${packageId}` : "/workflow",
      title: "Workflow",
      caption: "This package's life, record by record: sealed, three co-signed handovers, then the opening.",
    },
    {
      path: "/packages",
      title: "Packages",
      caption: "Every sealed bundle, ranked by custody risk rather than by centre code.",
    },
    {
      path: "/witness",
      title: "Ceremony",
      caption: "Two officials, two fingerprints inside 120 seconds, and a photograph at the moment of opening.",
    },
    {
      path: "/slots",
      title: "Slots",
      caption: "Which fingerprint slot belongs to which official. Only the slot number goes on the chain.",
    },
    {
      path: "/activity",
      title: "Activity",
      caption: "Every act that was just recorded, newest first, with the evidence behind each one.",
    },
    {
      path: "/keys",
      title: "Keys",
      caption: "The custody key for this six-hour window — it expires by arithmetic, nothing rotates it.",
    },
    {
      path: "/devices",
      title: "Devices",
      caption: "Every station that can sign a record, and the one centre each is bound to.",
    },
    {
      path: "/integrity",
      title: "Integrity",
      caption: "Every record carries the hash of the one before it. Change one and everything after it breaks.",
    },
    {
      path: "/failed",
      title: "Failed attempts",
      caption: "The wrong key and the torn flap — both refused, both recorded, neither thrown away.",
    },
    {
      path: "/demo",
      title: "Back to the demonstration",
      caption: "The paper opened only after every one of those records existed.",
    },
  ];
}

export function DemoTour() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [stops, setStops] = useState<Stop[] | null>(null);
  const [index, setIndex] = useState(0);
  const [left, setLeft] = useState(SECONDS);

  const expected = useRef<string | null>(null);
  const lastPath = useRef(pathname);

  const stop = useCallback(() => {
    setStops(null);
    expected.current = null;
  }, []);

  useEffect(() => {
    const onStart = (e: Event) => {
      const id = (e as CustomEvent<{ packageId?: string }>).detail?.packageId;
      setStops(plan(id));
      setIndex(0);
      setLeft(SECONDS);
    };
    window.addEventListener(EVENT, onStart);
    return () => window.removeEventListener(EVENT, onStart);
  }, []);

  // go to the current stop
  useEffect(() => {
    if (!stops) return;
    const s = stops[index];
    if (!s) {
      stop();
      return;
    }
    expected.current = s.path;
    setLeft(SECONDS);
    navigate(s.path);
  }, [stops, index, navigate, stop]);

  // one tick a second
  useEffect(() => {
    if (!stops) return;
    const t = window.setInterval(() => setLeft((l) => l - 1), 1000);
    return () => window.clearInterval(t);
  }, [stops, index]);

  // advance, or finish on the last stop
  useEffect(() => {
    if (!stops || left > 0) return;
    if (index + 1 >= stops.length) stop();
    else setIndex((i) => i + 1);
  }, [left, stops, index, stop]);

  // someone used the sidebar — the presenter has taken over
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (stops && expected.current && pathname !== expected.current) stop();
  }, [pathname, stops, stop]);

  useEffect(() => {
    if (!stops) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stops, stop]);

  if (!stops) return null;
  const s = stops[index];
  if (!s) return null;
  const progress = ((index + (SECONDS - Math.max(left, 0)) / SECONDS) / stops.length) * 100;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 1000,
        width: "min(720px, calc(100vw - 32px))",
        background: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border-strong)",
        borderRadius: 10,
        padding: "14px 18px",
        boxShadow: "none",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <strong style={{ fontSize: 16 }}>{s.title}</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {index + 1} / {stops.length} · {Math.max(left, 0)} s
        </span>
      </div>
      <div style={{ fontSize: 14.5, lineHeight: 1.45 }}>{s.caption}</div>
      <div style={{ height: 3, background: "var(--border)", borderRadius: 2 }}>
        <div
          style={{
            height: "100%",
            width: `${progress}%`,
            background: "var(--accent)",
            borderRadius: 2,
            transition: "width 1s linear",
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={stop}>
          Stop tour
        </button>
        <button
          className="btn"
          onClick={() => (index + 1 >= stops.length ? stop() : setIndex((i) => i + 1))}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
