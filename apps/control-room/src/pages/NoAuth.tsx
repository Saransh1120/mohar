import { Link, useLocation } from "react-router-dom";
import { Card } from "../components/ui";

/**
 * The catch-all.
 *
 * This page used to explain that sign-in did not exist. It does now — accounts
 * live in `ref.account` and sessions in `ref.session`, and `/signin` and
 * `/signup` render a real form outside the app shell. All that is left here is
 * the honest answer to a URL that is routed nowhere, because a page that
 * silently shows nothing is indistinguishable from a page that failed to load.
 */
export default function NoAuth() {
  const { pathname } = useLocation();

  return (
    <div style={{ maxWidth: 760 }}>
      <Card title="No such page" hint={pathname}>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-dim)" }}>
          Nothing is routed at <code>{pathname}</code>. Use the navigation on the left.
        </p>
        <div style={{ marginTop: 18 }}>
          <Link to="/overview" className="wit-btn" style={{ textDecoration: "none" }}>
            Back to the control room
          </Link>
        </div>
      </Card>
    </div>
  );
}
