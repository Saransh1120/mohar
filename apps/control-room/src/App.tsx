import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useAsync } from "./lib/hooks";
import Dashboard from "./pages/Dashboard";
import Packages from "./pages/Packages";
import PackageDetail from "./pages/PackageDetail";
import Activity from "./pages/Activity";
import Witness from "./pages/Witness";
import NoAuth from "./pages/NoAuth";
import SlotRegistry from "./pages/SlotRegistry";
import Keys from "./pages/Keys";
import Devices from "./pages/Devices";
import Integrity from "./pages/Integrity";
import FailedAttempts from "./pages/FailedAttempts";
import LiveDemo from "./pages/LiveDemo";
import { EvidenceProvider } from "./lib/evidence";

const PAGES: Record<string, { title: string; sub: string }> = {
  "/": {
    title: "Operations overview",
    sub: "What is moving, what was refused, and what nobody has resolved",
  },
  // `/` now belongs to the landing page, so the overview lives here. Same
  // component, same content — only the path moved.
  "/overview": {
    title: "Operations overview",
    sub: "What is moving, what was refused, and what nobody has resolved",
  },
  "/workflow": {
    title: "Paper workflow",
    sub: "Every event for one package, in order, with the full record behind each step",
  },
  "/packages": {
    title: "Packages",
    sub: "Every sealed bundle, ranked by custody risk rather than by centre code",
  },
  "/witness": {
    title: "Unlock ceremony",
    sub: "Two officials, two fingerprints, and a photograph committed to the chain at the moment the seal is broken",
  },
  "/slots": {
    title: "Template slots",
    sub: "Who each fingerprint slot belongs to — reference data, deliberately not in the chain",
  },
  "/activity": {
    title: "Activity ledger",
    sub: "Every recorded act with its full evidence — decisions, keys, positions, payloads",
  },
  "/keys": {
    title: "Custody keys",
    sub: "Stage-scoped keys, valid for one six-hour epoch and no longer",
  },
  "/devices": {
    title: "Devices",
    sub: "Enrolled signing keys. Revoking one invalidates nothing it already signed",
  },
  "/demo": {
    title: "Live demonstration",
    sub: "A paper sealed, split, refused, authorised and opened — using the system's own cryptography",
  },
  "/integrity": {
    title: "Chain integrity",
    sub: "Recompute the hash chain and inspect published Merkle anchors",
  },
};

export default function App() {
  const { pathname } = useLocation();
  const { account, signOut } = useAuth();
  const navigate = useNavigate();
  const { data: health } = useAsync(() => api.health(), [], { pollMs: 10_000 });
  const { data: summary } = useAsync(() => api.summary(), [], { pollMs: 10_000 });
  const { data: epoch } = useAsync(() => api.epoch(), [], { pollMs: 30_000 });

  const page =
    PAGES[pathname] ??
    (pathname.startsWith("/workflow/") || pathname.startsWith("/packages/")
      ? {
          title: "Paper workflow",
          sub: "Every event for this package, in order, with the full record behind each step",
        }
      : { title: "Control room", sub: "" });

  const packageCount = Object.values(summary?.packagesByState ?? {}).reduce(
    (a, b) => a + (b ?? 0),
    0,
  );
  const undecided = summary?.actsRequiringDecision ?? 0;
  const keyDenials = summary?.keyDenials ?? 0;
  const denials = summary?.access.denied ?? 0;
  const mins = epoch ? Math.floor(epoch.secondsRemaining / 60) : null;

  return (
    <EvidenceProvider>
      <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Mohar</h1>
          <div className="tag">Control Room</div>
        </div>

        <nav className="nav">
          <NavLink to="/overview">Overview</NavLink>
          <NavLink to="/workflow">Workflow</NavLink>
          <NavLink to="/packages">
            Packages
            {packageCount > 0 && <span className="nav-count">{packageCount}</span>}
          </NavLink>
          <NavLink to="/witness">Ceremony</NavLink>
          <NavLink to="/slots">Slots</NavLink>
          <NavLink to="/activity">
            Activity
            {undecided > 0 && <span className="nav-count alert">{undecided}</span>}
          </NavLink>
          <NavLink to="/keys">
            Keys
            {keyDenials > 0 && <span className="nav-count alert">{keyDenials}</span>}
          </NavLink>
          <NavLink to="/devices">
            Devices
            {summary && <span className="nav-count">{summary.totals.active_devices}</span>}
          </NavLink>
          <NavLink to="/integrity">Integrity</NavLink>
          <NavLink to="/demo">Live Demo</NavLink>
          <NavLink to="/failed">
            Failed Attempts
            {denials > 0 && <span className="nav-count alert">{denials}</span>}
          </NavLink>
        </nav>

        {account && (
          <div className="who">
            <div className="who-name">{account.displayName}</div>
            <div className="who-role">
              {account.role.replace(/_/g, " ")} · {account.username}
            </div>
            <button
              className="who-out"
              onClick={() => void signOut().then(() => navigate("/signin", { replace: true }))}
            >
              Sign out
            </button>
          </div>
        )}

        <div className="sidebar-foot">
          {epoch && (
            <div style={{ marginBottom: 8 }}>
              epoch {epoch.epoch}
              <br />
              <span style={{ opacity: 0.7 }}>keys rotate in {mins}m</span>
            </div>
          )}
          {health?.chainTip ? (
            <>
              chain tip #{health.chainTip.seq}
              <br />
              <span style={{ opacity: 0.7 }}>{health.chainTip.hash.slice(0, 16)}…</span>
            </>
          ) : (
            "chain empty"
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h2>{page.title}</h2>
            {page.sub && <div className="sub">{page.sub}</div>}
          </div>
          <div className="conn">
            <span className={`dot ${health?.ok ? "up" : "down"}`} />
            {health?.ok ? "ledger connected" : "ledger unreachable"}
          </div>
        </header>

        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/overview" element={<Dashboard />} />
            <Route path="/workflow" element={<PackageDetail />} />
            <Route path="/workflow/:id" element={<PackageDetail />} />
            <Route path="/packages" element={<Packages />} />
            <Route path="/packages/:id" element={<PackageDetail />} />
            <Route path="/witness" element={<Witness />} />
            <Route path="/slots" element={<SlotRegistry />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/integrity" element={<Integrity />} />
            <Route path="/failed" element={<FailedAttempts />} />
            <Route path="/demo" element={<LiveDemo />} />
            {/* Anything else renders an explanation rather than a blank panel.
                A page that silently shows nothing is indistinguishable from a
                page that failed to load. */}
            <Route path="*" element={<NoAuth />} />
          </Routes>
        </main>
      </div>
      </div>
    </EvidenceProvider>
  );
}
