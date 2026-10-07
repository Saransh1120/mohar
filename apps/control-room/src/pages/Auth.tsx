/**
 * Sign in and sign up.
 *
 * One component for both, because they are the same form with one extra field
 * and there is no reason for a visitor switching between them to watch the page
 * rebuild itself.
 *
 * The credential check behind this is real: the password is verified against a
 * scrypt hash in `ref.account`, a failure costs the same whether the username
 * exists or not, and a session is a random 256-bit token of which the server
 * keeps only the SHA-256. The session it yields is what `services/gateway`
 * checks before a request reaches the ledger; the note at the foot of the page
 * says what that covers.
 *
 * Registration closes once the first account exists (unless the ledger was
 * started with ALLOW_SIGNUP=true). Later accounts come from the Accounts page.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, type AuthConfig } from "../lib/api";
import { useAuth } from "../lib/auth";

const ROLE_LABELS: Record<string, string> = {
  control_room: "Control room",
  district_officer: "District officer",
  superintendent: "Centre superintendent",
  custodian: "Custodian",
  courier: "Courier",
  observer: "Observer",
};

export default function Auth({ mode }: { mode: "signin" | "signup" }) {
  const { account, checking, setAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/overview";

  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("control_room");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .authConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // Switching between the two modes should not carry an error about the other.
  useEffect(() => setError(null), [mode]);

  if (!checking && account) return <Navigate to={from} replace />;

  const isSignUp = mode === "signup";
  const firstAccount = isSignUp && config?.accounts === 0;
  const tooShort = isSignUp && password.length > 0 && password.length < 12;
  const mismatch = isSignUp && confirm.length > 0 && confirm !== password;
  // The ledger would refuse the submission anyway; a form that cannot succeed
  // is not offered.
  const closed = isSignUp && config !== null && !config.signUpOpen;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (isSignUp && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const session = isSignUp
        ? await api.signUp({ username, password, displayName, role })
        : await api.signIn(username, password);
      setAccount(session.account);
      navigate(from, { replace: true });
    } catch (err) {
      // A 5xx here is almost never the credential check failing — it is the Vite
      // proxy answering for a ledger service that is not running. Saying "500"
      // sends someone to look at their password; saying this sends them to the
      // terminal, which is where the problem actually is.
      // The browser's own passkey prompt failing is neither of those: the
      // password was accepted and the second step did not happen.
      const passkey = err instanceof DOMException || (err instanceof Error && /passkey|WebAuthn/i.test(err.message));
      const unreachable =
        !passkey && (!(err instanceof ApiError) || err.status >= 500 || err.status === 0);
      setError(
        passkey && !(err instanceof ApiError)
          ? err instanceof DOMException
            ? "Your password was accepted, but no passkey answered: the prompt was dismissed or timed out, or this device does not hold one of this account's passkeys. Sign in again."
            : (err as Error).message
          : unreachable
          ? "The control room cannot reach its API on :8081. Start it (pnpm start: the gateway, with the ledger behind it) and try again."
          : err.message,
      );
      setPassword("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Link to="/" className="auth-mark">
            Mohar
          </Link>
          <div className="auth-tag">Control Room</div>
        </div>

        <h1 className="auth-title">{isSignUp ? "Create an account" : "Sign in"}</h1>
        <p className="auth-sub">
          {isSignUp
            ? firstAccount
              ? "No accounts exist yet. The first one you create claims this control room, as its operator, and registration closes behind it."
              : config && !config.signUpOpen
                ? "Registration is closed on this deployment. A control room operator creates accounts, on the Accounts page."
                : "An account identifies you in the control room. It does not grant custody keys — those are issued per stage, per package."
            : "Twelve-hour session. Signing out ends it immediately, everywhere it was used."}
        </p>

        {error && <div className="auth-error">{error}</div>}

        <form
          className="auth-form"
          style={closed ? { display: "none" } : undefined}
          onSubmit={(e) => void submit(e)}
        >
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            required
            spellCheck={false}
            autoCapitalize="none"
            placeholder="r.sharma"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />

          {isSignUp && (
            <>
              <label htmlFor="displayName">Full name</label>
              <input
                id="displayName"
                name="displayName"
                autoComplete="name"
                required
                placeholder="Rohit Sharma"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />

              {/* The first account is the operator whatever is chosen, so the
                  chooser is not offered for it. */}
              {!firstAccount && (
                <>
                  <label htmlFor="role">Role</label>
                  <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
                    {(config?.roles ?? ["control_room"]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r] ?? r}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}

          <div className="auth-label-row">
            <label htmlFor="password">Password</label>
            <button type="button" className="auth-reveal" onClick={() => setReveal((v) => !v)}>
              {reveal ? "Hide" : "Show"}
            </button>
          </div>
          <input
            id="password"
            name="password"
            type={reveal ? "text" : "password"}
            autoComplete={isSignUp ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isSignUp && (
            <div className={`auth-hint${tooShort ? " bad" : ""}`}>
              At least 12 characters. Length is what makes a password hard to guess — there is
              no character-class rule to satisfy.
            </div>
          )}

          {isSignUp && (
            <>
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                name="confirm"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && <div className="auth-hint bad">The two passwords do not match.</div>}
            </>
          )}

          <button
            type="submit"
            className="auth-submit"
            disabled={busy || (isSignUp && (tooShort || mismatch))}
          >
            {busy
              ? isSignUp
                ? "Creating account…"
                : "Signing in…"
              : isSignUp
                ? "Create account and continue"
                : "Sign in"}
          </button>
        </form>

        <div className="auth-switch">
          {isSignUp ? (
            <>
              Already have an account? <Link to="/signin">Sign in</Link>
            </>
          ) : config && !config.signUpOpen ? (
            <>Registration is closed on this deployment.</>
          ) : (
            <>
              No account yet? <Link to="/signup">Create one</Link>
            </>
          )}
        </div>

        <p className="auth-foot">
          Signing in is what the <code>gateway</code> checks before a request reaches the ledger:
          issuing a key or enrolling a device takes a control room operator's session, and an event
          is accepted only with an enrolled device's signature. The ledger itself checks none of
          this, so it stays bound to localhost behind the gateway.
        </p>
      </div>
    </div>
  );
}
