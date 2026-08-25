/**
 * Mohar — landing page.
 *
 * A marketing entry page that sits in front of the control room. It renders no
 * control-room chrome, mounts none of its pages, and writes nothing. Every
 * factual claim below is taken from material already in this repository:
 * feature copy is verbatim from the `PAGES` map in App.tsx, the incident figures
 * are from docs/00-overview.md, and the counters are read live from the existing
 * /summary and /health endpoints — no endpoint was added or changed for this.
 *
 * If the ledger is unreachable the counter strip simply does not render. It
 * never falls back to invented numbers, because a landing page that fabricates
 * its own telemetry is exactly the thing this product exists to argue against.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { api } from "../lib/api";
import MagneticButton from "./MagneticButton";
import "./landing.css";

gsap.registerPlugin(ScrollTrigger);

/** Where the CTA sends people. The control room's own entry screen. */
const APP_ROUTE = "/overview";

/**
 * Auth destinations for the navbar buttons.
 *
 * This project has no authentication yet — `services/gateway/src/auth/` holds
 * only a `.gitkeep`, and the ledger API is unauthenticated (recorded as a known
 * gap in docs/learn). Nothing here creates, replaces, or stands in for auth; the
 * buttons simply point at the conventional routes so that the day sign-in and
 * sign-up pages exist, wiring them up is a one-line change to each constant.
 */
const SIGN_IN_ROUTE = "/signin";
const SIGN_UP_ROUTE = "/signup";

const still = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── icons (inline, so the landing adds no icon dependency) ─────────────────

const Ico = {
  overview: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  workflow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><path d="M5 8v8" />
      <path d="M9 6h6a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H11a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h6" />
    </svg>
  ),
  packages: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5" /><path d="M12 12v10" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  ),
  keys: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="12" r="4" /><path d="M12 12h9" /><path d="M17 12v4" /><path d="M20 12v3" />
    </svg>
  ),
  devices: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" />
    </svg>
  ),
  integrity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6z" /><path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

/**
 * Existing features only. Titles and descriptions are copied verbatim from the
 * PAGES map in App.tsx so this page cannot drift from what the app actually is.
 */
const FEATURES = [
  { icon: Ico.overview, title: "Operations overview", route: "/overview",
    body: "What is moving, what was refused, and what nobody has resolved." },
  { icon: Ico.workflow, title: "Paper workflow", route: "/workflow",
    body: "Every event for one package, in order, with the full record behind each step." },
  { icon: Ico.packages, title: "Packages", route: "/packages",
    body: "Every sealed bundle, ranked by custody risk rather than by centre code." },
  { icon: Ico.activity, title: "Activity ledger", route: "/activity",
    body: "Every recorded act with its full evidence — decisions, keys, positions, payloads." },
  { icon: Ico.keys, title: "Custody keys", route: "/keys",
    body: "Stage-scoped keys, valid for one six-hour epoch and no longer." },
  { icon: Ico.devices, title: "Devices", route: "/devices",
    body: "Enrolled signing keys. Revoking one invalidates nothing it already signed." },
  { icon: Ico.integrity, title: "Chain integrity", route: "/integrity",
    body: "Recompute the hash chain and inspect published Merkle anchors." },
] as const;

const TRUST = [
  { h: "Hash-chained ledger", p: "Each entry binds to the one before it. Altering a past record breaks every hash that follows, and anyone can recompute the chain.", c: "SHA256(prevHash ‖ bodyHash)" },
  { h: "Signed by the device", p: "Every event carries an Ed25519 signature over RFC 8785 canonical JSON, so a signature made offline still verifies after a database round trip.", c: "Ed25519 · RFC 8785 JCS" },
  { h: "Append-only by grant", p: "The application's database role holds INSERT and SELECT. There is no UPDATE or DELETE grant, so the service cannot rewrite history even if it is compromised.", c: "grant select, insert" },
  { h: "Published Merkle anchors", p: "A daily RFC 6962 tree lets a third party prove one event was included without being shown any other event.", c: "RFC 6962 inclusion proof" },
  { h: "Keys that expire by arithmetic", p: "A custody key is valid for one six-hour epoch. Nothing rotates them — no scheduler to fail open. If the infrastructure breaks, access is denied.", c: "epoch = ⌊unix / 21600⌋" },
  { h: "Deny by default", p: "Fifteen checks run on every access request, always, with no short-circuit. The attempt is written to the ledger before the caller is told the outcome.", c: "15 checks · evidence, not verdicts" },
];

const SHOWCASE = [
  { idx: "01", h: "Every step, on the record", vis: "chain",
    p: "The workflow view replays a package from seal to destruction. Under each event sits the full record behind it — actor, device, position, clock skew, body hash, chain hash, and the verbatim payload.",
    fact: "8 custody stages · seal → destroy" },
  { idx: "02", h: "Risk, derived not declared", vis: "radar",
    p: "Package state is never a column somebody updates. It is replayed from events, so a missing handover produces a visible gap rather than a plausible-looking timeline.",
    fact: "observed state vs declared state" },
  { idx: "03", h: "Keys that die on schedule", vis: "epoch",
    p: "A custody key is scoped to one package and one stage, and lives for a single six-hour epoch. Expiry is arithmetic against the clock, so there is no job whose failure would quietly leave keys valid.",
    fact: "6-hour epochs · ±30 min grace" },
  { idx: "04", h: "Refusals are the evidence", vis: "checks",
    p: "A denied attempt records what was observed rather than what was concluded — 412 metres, not 'outside geofence'. Evidence can be re-examined years later; a verdict cannot.",
    fact: "attempt written before response" },
] as const;

const MARQUEE = [
  "Hash-chained custody", "Ed25519 attribution", "Append-only ledger",
  "Six-hour custody keys", "Merkle anchors", "Deny by default", "Evidence, not verdicts",
];

// ── page ───────────────────────────────────────────────────────────────────

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const heroInner = useRef<HTMLDivElement>(null);
  const featuresTop = useRef<HTMLElement>(null);
  const showViewport = useRef<HTMLDivElement>(null);
  const showTrack = useRef<HTMLDivElement>(null);

  const [stats, setStats] = useState<
    { events: number; packages: number; devices: number; centres: number } | null
  >(null);

  // Live counters from the existing API. Silent on failure — never invented.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.summary();
        if (!alive) return;
        const packages = Object.values(s.packagesByState).reduce<number>(
          (a, b) => a + (b ?? 0),
          0,
        );
        setStats({
          events: s.totals.events,
          packages,
          devices: s.totals.active_devices,
          centres: s.totals.centres,
        });
      } catch {
        /* ledger not running — the strip stays hidden */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!root.current) return;
    const reduced = still();

    const ctx = gsap.context(() => {
      // ── hero reveal ────────────────────────────────────────────────────
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      tl.from(".l-nav-brand", { y: -14, opacity: 0, duration: 0.6 })
        .from(".l-nav-actions > *", { y: -14, opacity: 0, duration: 0.55, stagger: 0.1 }, "-=0.4")
        .from(".l-wordmark", { y: 18, opacity: 0, duration: 0.7 }, "-=0.25")
        .from(
          ".l-hero h1 .word",
          { yPercent: 116, opacity: 0, duration: 0.95, stagger: 0.07 },
          "-=0.35",
        )
        .from(".l-hero-sub", { y: 26, opacity: 0, duration: 0.8 }, "-=0.55")
        .from(".l-cta-row .l-btn", { y: 22, opacity: 0, duration: 0.6, stagger: 0.11 }, "-=0.45")
        .from(".l-live", { y: 22, opacity: 0, duration: 0.7 }, "-=0.35")
        .from(".l-scroll-hint", { opacity: 0, duration: 0.7 }, "-=0.3");

      if (reduced) tl.progress(1);

      // ── scroll reveals ─────────────────────────────────────────────────
      gsap.utils.toArray<HTMLElement>(".l-reveal").forEach((el) => {
        gsap.to(el, {
          opacity: 1,
          y: 0,
          duration: 0.85,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 86%", once: true },
        });
      });

      gsap.utils.toArray<HTMLElement>(".l-stagger").forEach((group) => {
        gsap.to(group.children, {
          opacity: 1,
          y: 0,
          duration: 0.75,
          ease: "power3.out",
          stagger: 0.09,
          scrollTrigger: { trigger: group, start: "top 84%", once: true },
        });
      });

      // ── nav condenses once the hero starts leaving ─────────────────────
      // Not an animation, so it stays active under reduced-motion too.
      ScrollTrigger.create({
        start: 80,
        end: "max",
        onToggle: (self) => nav.current?.classList.toggle("scrolled", self.isActive),
      });

      if (reduced) return;

      // ── hero parallax on pointer ───────────────────────────────────────
      const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      if (fine && heroInner.current) {
        const onMove = (e: MouseEvent) => {
          const cx = (e.clientX / window.innerWidth - 0.5) * 2;
          const cy = (e.clientY / window.innerHeight - 0.5) * 2;
          gsap.to(heroInner.current, {
            x: cx * 14,
            y: cy * 10,
            duration: 1.1,
            ease: "power2.out",
          });
          gsap.to(".l-aurora.a1", { x: cx * -34, y: cy * -22, duration: 1.6, ease: "power2.out" });
          gsap.to(".l-aurora.a3", { x: cx * 26, y: cy * 18, duration: 1.6, ease: "power2.out" });
        };
        window.addEventListener("mousemove", onMove);
        ScrollTrigger.addEventListener("refreshInit", () => gsap.set(heroInner.current, { x: 0, y: 0 }));
        return () => window.removeEventListener("mousemove", onMove);
      }
    }, root);

    return () => ctx.revert();
  }, []);

  // Pinned horizontal showcase. Kept in its own effect so it can rebuild on
  // resize without tearing down the hero timeline.
  useLayoutEffect(() => {
    const vp = showViewport.current;
    const track = showTrack.current;
    if (!vp || !track) return;
    if (still()) return;
    // Below 900px the panels stack vertically; pinning there fights the layout.
    if (window.innerWidth < 900) return;

    const ctx = gsap.context(() => {
      const distance = () => track.scrollWidth - window.innerWidth;
      gsap.to(track, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: vp,
          start: "top top",
          end: () => `+=${distance()}`,
          scrub: 0.9,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      });
    }, vp);

    return () => ctx.revert();
  }, []);

  const scrollToFeatures = () =>
    featuresTop.current?.scrollIntoView({ behavior: still() ? "auto" : "smooth", block: "start" });

  const toTop = () =>
    window.scrollTo({ top: 0, behavior: still() ? "auto" : "smooth" });

  return (
    <div className="mohar-landing" ref={root}>
      {/* ══ 0 · TOP NAV ═══════════════════════════════════════════════════ */}
      <nav className="l-nav" ref={nav}>
        <div className="l-nav-in">
          <Link to="/" className="l-nav-brand" aria-label="Mohar — home">
            <span className="seal" />
            <span className="n">Mohar</span>
          </Link>

          <div className="l-nav-actions">
            <MagneticButton
              as={Link}
              to={SIGN_IN_ROUTE}
              className="l-btn-auth l-btn-signin"
              strength={0.22}
            >
              Sign In
            </MagneticButton>

            <MagneticButton
              as={Link}
              to={SIGN_UP_ROUTE}
              className="l-btn-auth l-btn-signup"
              strength={0.22}
            >
              <span className="tick" />
              Sign Up
            </MagneticButton>
          </div>
        </div>
      </nav>

      {/* ══ 1 · HERO ══════════════════════════════════════════════════════ */}
      <header className="l-hero">
        <div className="l-grid" />
        <div className="l-aurora a1" />
        <div className="l-aurora a2" />
        <div className="l-aurora a3" />
        <Particles />

        <div className="l-hero-inner" ref={heroInner}>
          <div className="l-wordmark">
            <span className="seal" />
            <span className="name">Mohar</span>
          </div>

          <h1>
            <span className="line">
              <span className="word">Custody</span> <span className="word">you</span>{" "}
              <span className="word">can</span>
            </span>
            <span className="line">
              <span className="word accent">prove.</span>
            </span>
          </h1>

          <p className="l-hero-sub">
            A sealed custody chain for examination papers. Every handover is signed by the
            person who performed it and written into an <strong>append-only ledger</strong> that
            nobody — including its operators — can edit without it being visible.
          </p>

          <div className="l-cta-row">
            <MagneticButton
              as={Link}
              to={APP_ROUTE}
              className="l-btn l-btn-primary"
              strength={0.3}
            >
              Open Control Room
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
              </svg>
            </MagneticButton>

            <MagneticButton
              as="button"
              type="button"
              onClick={scrollToFeatures}
              className="l-btn l-btn-ghost"
              strength={0.25}
            >
              See how it works
            </MagneticButton>
          </div>

          {stats && (
            <div className="l-live">
              <div className="l-live-cell">
                <span className="v">{stats.events.toLocaleString("en-IN")}</span>
                <span className="k">Chained events</span>
              </div>
              <div className="l-live-cell">
                <span className="v">{stats.packages}</span>
                <span className="k">Packages tracked</span>
              </div>
              <div className="l-live-cell">
                <span className="v">{stats.devices}</span>
                <span className="k">Enrolled devices</span>
              </div>
              <div className="l-live-cell">
                <span className="v">{stats.centres}</span>
                <span className="k">Centres</span>
              </div>
            </div>
          )}
        </div>

        <div className="l-scroll-hint">
          <span className="rail" />
          Scroll
        </div>
      </header>

      {/* ══ 2 · WHY IT EXISTS ═════════════════════════════════════════════ */}
      <section className="l-section l-why">
        <div className="l-reveal">
          <span className="l-eyebrow"><span className="dot" /> Why it exists</span>
          <h2 className="l-h2">Leaks are found. Cases are not won.</h2>
          <p className="l-lede">
            Question papers travel a long physical road — sealed, couriered, held overnight,
            delivered, stored, and opened minutes before an examination. Leaks happen along
            that road, and they are usually discovered within days.
          </p>
        </div>

        <div className="l-stat-row l-stagger">
          <div className="l-stat l-glass l-reveal">
            <span className="n">148</span>
            <span className="l">exam-fraud incidents documented between 2015 and 2026</span>
          </div>
          <div className="l-stat l-glass l-reveal">
            <span className="n">21</span>
            <span className="l">Indian states across which those incidents occurred</span>
          </div>
          <div className="l-stat l-glass l-reveal">
            <span className="n">~70%</span>
            <span className="l">of those cases were paper leaks</span>
          </div>
          <div className="l-stat l-glass l-reveal">
            <span className="n">1</span>
            <span className="l">conviction produced across all of them</span>
          </div>
        </div>

        <div className="l-verdict l-reveal">
          <p>
            The failure is therefore not primarily detection. It is <em>evidence and
            attribution</em> — chain of custody cannot be proved to a court's standard, and
            no one can say which centre a leaked image came from. Mohar is built to close
            that gap, not to promise a leak-proof examination.
          </p>
        </div>
      </section>

      <div className="l-marquee">
        <div className="l-marquee-track">
          <MarqueeGroup /><MarqueeGroup />
        </div>
      </div>

      {/* ══ 3 · EXISTING FEATURES ═════════════════════════════════════════ */}
      <section className="l-section" ref={featuresTop} id="features">
        <div className="l-reveal">
          <span className="l-eyebrow"><span className="dot" /> Inside the control room</span>
          <h2 className="l-h2">Seven surfaces, one record.</h2>
          <p className="l-lede">
            Everything the control room shows is derived from the same signed ledger. No
            screen holds a number that cannot be traced back to the events that produced it.
          </p>
        </div>

        <div className="l-feat-grid l-stagger">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* ══ 4 · SHOWCASE ══════════════════════════════════════════════════ */}
      <section className="l-showcase">
        <div className="l-show-viewport" ref={showViewport}>
          <div className="l-grid" />
          <div className="l-show-track" ref={showTrack}>
            {SHOWCASE.map((s) => (
              <article className="l-show-panel" key={s.idx}>
                <div className="l-show-copy">
                  <span className="idx">{s.idx} —</span>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                  <span className="fact l-mono">{s.fact}</span>
                </div>
                <div className="l-show-vis l-glass">
                  <Visual kind={s.vis} />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ══ 5 · TRUST ═════════════════════════════════════════════════════ */}
      <section className="l-section l-trust">
        <div className="l-scanline" />
        <div className="l-reveal">
          <span className="l-eyebrow"><span className="dot" /> How the record holds</span>
          <h2 className="l-h2">Tamper-evident, not merely trusted.</h2>
          <p className="l-lede">
            The guarantee is not that the record cannot be altered. It is that alteration
            cannot be hidden — from an investigator, from an auditor, or from the people who
            run the system.
          </p>
        </div>

        <div className="l-trust-grid l-stagger">
          {TRUST.map((t) => (
            <div className="l-trust-item l-glass l-reveal" key={t.h}>
              <div className="node" />
              <h4>{t.h}</h4>
              <p>{t.p}</p>
              <code className="l-mono">{t.c}</code>
            </div>
          ))}
        </div>

        <div className="l-disclaim l-reveal">
          <strong>Stated plainly:</strong> Mohar does not make examinations leak-proof. Someone
          with legitimate access at the moment a bundle is opened can still photograph a paper.
          What changes is the cost — the exposure window narrows, and every act carries an
          attributable, tamper-evident record.
        </div>
      </section>

      {/* ══ 6 · FINAL CTA ═════════════════════════════════════════════════ */}
      <section className="l-final">
        <div className="l-grid" />
        <div className="l-aurora a1" />
        <div className="l-ghost-text">MOHAR</div>

        <h2>Ready to begin?</h2>
        <p>
          Open the control room to see what is moving, what was refused, and what nobody has
          resolved.
        </p>
        <div className="l-cta-row">
          <MagneticButton as={Link} to={APP_ROUTE} className="l-btn l-btn-primary" strength={0.3}>
            Open Control Room
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
            </svg>
          </MagneticButton>
        </div>
      </section>

      {/* ══ FOOTER ════════════════════════════════════════════════════════ */}
      <footer className="l-footer">
        <div className="l-footer-in">
          <div className="fm">
            <span className="seal" />
            <span className="n">Mohar</span>
          </div>
          <p className="note">
            A sealed custody chain for examination papers. Records are hash-chained and signed;
            state is derived from events, never declared.
          </p>
          <button className="l-top" onClick={toTop} aria-label="Back to top" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 10l7-7 7 7" /><path d="M12 3v18" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}

// ── small pieces ───────────────────────────────────────────────────────────

function FeatureCard({
  icon, title, body, route,
}: { icon: JSX.Element; title: string; body: string; route: string }) {
  const ref = useRef<HTMLAnchorElement>(null);

  // Cursor-follow glow. Cheap because it only writes two custom properties.
  const onMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  return (
    <Link to={route} className="l-feat l-glass l-reveal" ref={ref} onMouseMove={onMove}>
      <div className="l-feat-ico">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      <span className="route l-mono">{route}</span>
    </Link>
  );
}

function MarqueeGroup() {
  return (
    <div className="l-marquee-group">
      {MARQUEE.map((m) => (
        <span key={m}>
          {m} <span className="sep">✦</span>
        </span>
      ))}
    </div>
  );
}

function Particles() {
  // Fewer on small screens; none at all when motion is reduced (CSS hides them).
  const [n, setN] = useState(0);
  useEffect(() => setN(window.innerWidth < 640 ? 10 : 26), []);
  return (
    <div className="l-particles">
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className="l-particle"
          style={{
            left: `${(i * 37) % 100}%`,
            bottom: `-${(i % 5) * 6}px`,
            animationDuration: `${11 + (i % 7) * 2.6}s`,
            animationDelay: `${(i % 11) * 1.15}s`,
            opacity: 0,
          }}
        />
      ))}
    </div>
  );
}

function Visual({ kind }: { kind: string }) {
  if (kind === "chain") {
    return (
      <div className="vis-chain">
        {["#188 · custody.handover", "#189 · centre.received", "#190 · unlock.granted"].map(
          (t, i) => (
            <div className="blk l-mono" key={t} style={{ animationDelay: `${i * 0.45}s` }}>
              {t}
            </div>
          ),
        )}
      </div>
    );
  }
  if (kind === "radar") {
    return (
      <div className="vis-radar">
        <div className="ring" /><div className="ring" /><div className="ring" /><div className="ring" />
        <div className="sweep" />
        <div className="node" style={{ top: "26%", left: "62%" }} />
        <div className="node" style={{ top: "58%", left: "34%", animationDelay: "0.6s" }} />
        <div className="node" style={{ top: "71%", left: "68%", animationDelay: "1.2s" }} />
      </div>
    );
  }
  if (kind === "epoch") {
    return (
      <div className="vis-epoch">
        <svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="3" />
          <circle
            cx="50" cy="50" r="42" fill="none" stroke="url(#eg)" strokeWidth="3"
            strokeLinecap="round" strokeDasharray="264" strokeDashoffset="92"
          />
          <defs>
            <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#35d6f0" /><stop offset="100%" stopColor="#8b5cf6" />
            </linearGradient>
          </defs>
        </svg>
        <div className="cap">
          <span className="big">06:00</span>
          <span className="sm">epoch length</span>
        </div>
      </div>
    );
  }
  return (
    <div className="vis-checks">
      {["key", "epoch", "stage", "device", "bind", "roster", "role", "geo", "acc",
        "window", "skew", "seal", "state", "exam", "✓"].map((c, i) => (
        <div className="c" key={c} style={{ animationDelay: `${i * 0.13}s` }}>
          {c}
        </div>
      ))}
    </div>
  );
}
