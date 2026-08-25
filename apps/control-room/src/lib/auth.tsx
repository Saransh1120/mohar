/**
 * Who is looking at this control room.
 *
 * One provider at the root resolves the stored session token once, and everything
 * below reads the answer. Three states matter and they are kept distinct: still
 * checking, signed in, and signed out. Collapsing "checking" into "signed out" is
 * what makes an app flash its login screen at someone who is already signed in.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, type Account } from "./api";

interface AuthState {
  account: Account | null;
  /** True until the stored token has been checked against the server. */
  checking: boolean;
  setAccount: (a: Account | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    void api
      .me()
      .then((a) => {
        if (alive) setAccount(a);
      })
      // A ledger that is down is not the same as a session that is invalid, but
      // either way there is nobody to show the control room to yet.
      .catch(() => {
        if (alive) setAccount(null);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const signOut = useCallback(async () => {
    await api.signOut();
    setAccount(null);
  }, []);

  const value = useMemo(
    () => ({ account, checking, setAccount, signOut }),
    [account, checking, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth used outside AuthProvider");
  return ctx;
}

/**
 * Gate for the control room itself.
 *
 * The redirect carries where the visitor was heading, so signing in lands them
 * on the page they asked for rather than dumping everyone on the overview.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { account, checking } = useAuth();
  const location = useLocation();

  if (checking) {
    return (
      <div className="auth-checking">
        <div className="auth-checking-mark" />
        <span>Checking your session…</span>
      </div>
    );
  }

  if (!account) {
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
