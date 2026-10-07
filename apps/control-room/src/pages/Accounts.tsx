import { useState, type FormEvent } from "react";
import { api, ApiError, type Centre, type ListedAccount } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsync, formatTime, relativeTime } from "../lib/hooks";
import { Card, Empty } from "../components/ui";

/**
 * ── Who can sign in, and what the gateway turned away ────────────────────────
 *
 * Registration is closed once the first account exists, so this is where the
 * accounts after it come from: a control room operator creates them. An account
 * is disabled, never deleted — an acknowledgement or an override decision it
 * made last week still has to name who made it.
 *
 * An account can be limited to named centres. It then reads those centres'
 * packets, hand-offs and alerts and is refused everything else, whatever its
 * role. Each change is raised as an alert.
 *
 * The second half is the gateway's own record: requests it refused before they
 * reached an engine. Each row is what was asked, by whom, and what was found —
 * the role held against the role needed, the skew in seconds, the limit that
 * was hit. It is kept in the gateway's memory and starts empty when the gateway
 * restarts; refusals made by the engines themselves are on the Activity and
 * Failed Attempts pages, in the database.
 */

const ROLE_LABELS: Record<string, string> = {
  control_room: "Control room",
  district_officer: "District officer",
  superintendent: "Centre superintendent",
  custodian: "Custodian",
  courier: "Courier",
  observer: "Observer",
};

function detailText(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export default function Accounts() {
  const { account } = useAuth();
  const isOperator = account?.role === "control_room";

  const config = useAsync(() => api.authConfig(), []);
  const accounts = useAsync(() => api.accounts(), [], { pollMs: 30_000 });
  const gateway = useAsync(() => api.gatewayStatus(), [], { pollMs: 10_000 });

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("control_room");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const centres = useAsync(() => api.centres(), []);
  /** The account whose centre limit is being edited, and what is ticked. */
  const [limiting, setLimiting] = useState<ListedAccount | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [tickedDistricts, setTickedDistricts] = useState<Set<string>>(new Set());
  /** Putting centres in a district: the name typed and the centres ticked. */
  const [districtName, setDistrictName] = useState("");
  const [districtCentres, setDistrictCentres] = useState<Set<string>>(new Set());
  const [districtSaid, setDistrictSaid] = useState<string | null>(null);

  if (!isOperator) {
    return (
      <div className="note">
        <strong>Accounts are kept by a control room operator.</strong> You are signed in as{" "}
        {ROLE_LABELS[account?.role ?? ""] ?? account?.role}. The gateway refuses this page's
        requests for any other role, and so does the ledger behind it.
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreated(null);
    if (password.length < 12) return setFormError("Password must be at least 12 characters.");
    setBusy(true);
    try {
      const r = await api.createAccount({ username, displayName, role, password });
      setCreated(`${r.account.displayName} (${r.account.username}) can now sign in.`);
      setUsername("");
      setDisplayName("");
      setPassword("");
      await accounts.refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable(a: ListedAccount) {
    const reason = window.prompt(
      `Disable ${a.displayName} (${a.username})?\n\n` +
        "Their sessions end now and they cannot sign in again. Why? This is kept on the record.",
    );
    if (!reason?.trim()) return;
    setFormError(null);
    try {
      await api.disableAccount(a.id, reason.trim());
      await accounts.refresh();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  function editLimit(a: ListedAccount) {
    setFormError(null);
    setLimiting(a);
    setTicked(new Set(a.centreIds ?? []));
    setTickedDistricts(new Set(a.districts ?? []));
  }

  async function saveLimit(centreIds: string[], districts: string[]) {
    if (!limiting) return;
    setFormError(null);
    setBusy(true);
    try {
      await api.setAccountLimit(limiting.id, centreIds, districts);
      setLimiting(null);
      await accounts.refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDistrict(district: string | null) {
    setFormError(null);
    setDistrictSaid(null);
    setBusy(true);
    try {
      const r = await api.setCentreDistrict([...districtCentres], district);
      setDistrictSaid(
        `${r.changed} centre${r.changed === 1 ? "" : "s"} ${district ? `now in ${r.district}` : "taken out of a district"}` +
          (r.accountsAffected > 0
            ? `. ${r.accountsAffected} account${r.accountsAffected === 1 ? " sees" : "s see"} a different set of centres; an alert was raised.`
            : ". No account is limited to a district this changes."),
      );
      setDistrictCentres(new Set());
      await centres.refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(set: Set<string>, put: (s: Set<string>) => void, id: string, on: boolean) {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    put(next);
  }

  const allCentres: Centre[] = centres.data?.centres ?? [];
  const codeOf = new Map(allCentres.map((c) => [c.id, c.code]));
  const allDistricts = [...new Set(allCentres.map((c) => c.district).filter((d): d is string => !!d))].sort(
    (a, b) => a.localeCompare(b),
  );
  const list = accounts.data?.accounts ?? [];
  const noGateway = gateway.error instanceof ApiError && gateway.error.status === 404;
  const refusedByReason = Object.entries(gateway.data?.refusedByReason ?? {}).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <>
      <div className="note">
        {config.data?.signUpOpen ? (
          <>
            <strong>Registration is open.</strong> Anyone who can reach the sign-up page can create
            an account and choose its role. Start the ledger without{" "}
            <span className="mono">ALLOW_SIGNUP=true</span> to close it; accounts are then created
            here.
          </>
        ) : (
          <>
            <strong>Registration is closed.</strong> The first account claimed this control room.
            Every account after it is created here, by an operator, and none of them can create
            another unless its role is control room.
          </>
        )}
      </div>

      {formError && <div className="banner">{formError}</div>}

      <Card title="Create an account" hint="It does not sign you in as them; give them the password another way">
        <form className="slot-form" onSubmit={(e) => void submit(e)}>
          <label>
            <span>Username</span>
            <input
              className="wit-select"
              required
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              placeholder="r.sharma"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            <span>Full name</span>
            <input
              className="wit-select"
              required
              autoComplete="off"
              placeholder="Rohit Sharma"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            <span>Role</span>
            <select className="wit-select" value={role} onChange={(e) => setRole(e.target.value)}>
              {(config.data?.roles ?? ["control_room"]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r] ?? r}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Password (12 or more)</span>
            <input
              className="wit-select"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
        {created && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>{created}</div>
        )}
      </Card>

      <Card
        title="Accounts"
        hint={`${list.filter((a) => !a.disabledAt).length} can sign in`}
        flush
        actions={<button onClick={() => void accounts.refresh()}>Refresh</button>}
      >
        {accounts.error ? (
          <Empty>{accounts.error.message}</Empty>
        ) : list.length === 0 ? (
          <Empty>No accounts.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Centres</th>
                <th>Created</th>
                <th>Last sign-in</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} style={a.disabledAt ? { opacity: 0.5 } : undefined}>
                  <td>
                    {a.displayName}
                    {a.id === account?.id && (
                      <span style={{ color: "var(--text-faint)", fontSize: 11 }}> · you</span>
                    )}
                  </td>
                  <td className="mono">{a.username}</td>
                  <td>
                    <span className="badge neutral">{ROLE_LABELS[a.role] ?? a.role}</span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {(a.centreIds?.length ?? 0) + (a.districts?.length ?? 0) === 0 ? (
                      <span style={{ color: "var(--text-faint)" }}>no limit</span>
                    ) : (
                      <span className="mono" title="Reads these centres' packets, hand-offs and alerts; nothing else">
                        {[
                          ...(a.districts ?? []).map((d) => `${d} (district)`),
                          ...(a.centreIds ?? []).map((id) => codeOf.get(id) ?? id.slice(0, 8)),
                        ].join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="mono" title={formatTime(a.createdAt)}>
                    {relativeTime(a.createdAt)}
                  </td>
                  <td className="mono" title={a.lastSignIn ? formatTime(a.lastSignIn) : ""}>
                    {a.lastSignIn ? relativeTime(a.lastSignIn) : "never"}
                  </td>
                  <td>
                    {a.disabledAt ? (
                      <span title={formatTime(a.disabledAt)}>
                        disabled{a.disabledReason ? `: ${a.disabledReason}` : ""}
                      </span>
                    ) : (
                      "active"
                    )}
                  </td>
                  <td>
                    {!a.disabledAt && (
                      <>
                        <button onClick={() => editLimit(a)} style={{ marginRight: 6 }}>
                          Centres
                        </button>
                        <button className="danger" onClick={() => void disable(a)}>
                          Disable
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {limiting && (
        <Card
          title={`Centres for ${limiting.displayName} (${limiting.username})`}
          hint="What is ticked is all it will see. It will change nothing, whatever its role"
          actions={<button onClick={() => setLimiting(null)}>Cancel</button>}
        >
          {centres.error ? (
            <Empty>{centres.error.message}</Empty>
          ) : allCentres.length === 0 ? (
            <Empty>No centres are registered yet.</Empty>
          ) : (
            <>
              {allDistricts.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
                    Districts: whichever centres are in one when the account asks
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginBottom: 12 }}>
                    {allDistricts.map((d) => (
                      <label key={d} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={tickedDistricts.has(d)}
                          onChange={(e) => toggle(tickedDistricts, setTickedDistricts, d, e.target.checked)}
                        />
                        <span>
                          {d}{" "}
                          <span style={{ color: "var(--text-faint)" }}>
                            ({allCentres.filter((c) => c.district === d).length})
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>Centres, by name</div>
                </>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginBottom: 12 }}>
                {allCentres.map((c) => (
                  <label key={c.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={ticked.has(c.id)}
                      onChange={(e) => toggle(ticked, setTicked, c.id, e.target.checked)}
                    />
                    <span className="mono">{c.code}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <button
            className="primary"
            disabled={busy || ticked.size + tickedDistricts.size === 0}
            onClick={() => void saveLimit([...ticked], [...tickedDistricts])}
            style={{ marginRight: 8 }}
          >
            Limit to what is ticked
          </button>
          <button
            disabled={busy || (limiting.centreIds?.length ?? 0) + (limiting.districts?.length ?? 0) === 0}
            onClick={() => void saveLimit([], [])}
          >
            Lift the limit
          </button>
        </Card>
      )}

      <Card
        title="Districts"
        hint="A name on a centre. An account limited to a district sees whichever centres carry it"
      >
        {allCentres.length === 0 ? (
          <Empty>No centres are registered yet.</Empty>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginBottom: 12 }}>
              {allCentres.map((c) => (
                <label key={c.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={districtCentres.has(c.id)}
                    onChange={(e) => toggle(districtCentres, setDistrictCentres, c.id, e.target.checked)}
                  />
                  <span className="mono">{c.code}</span>
                  <span style={{ color: "var(--text-faint)" }}>{c.district ?? "no district"}</span>
                </label>
              ))}
            </div>
            <input
              className="wit-select"
              style={{ maxWidth: 240, marginRight: 8 }}
              placeholder="District name, e.g. Jaipur"
              value={districtName}
              onChange={(e) => setDistrictName(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || districtCentres.size === 0 || districtName.trim().length < 2}
              onClick={() => void saveDistrict(districtName.trim())}
              style={{ marginRight: 8 }}
            >
              Put {districtCentres.size} in this district
            </button>
            <button disabled={busy || districtCentres.size === 0} onClick={() => void saveDistrict(null)}>
              Take out of their district
            </button>
            {districtSaid && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>{districtSaid}</div>
            )}
          </>
        )}
      </Card>

      <Card
        title="Refused at the gateway"
        hint={
          gateway.data
            ? `since ${formatTime(gateway.data.startedAt)} · ${gateway.data.forwarded} forwarded`
            : ""
        }
        flush
      >
        {noGateway ? (
          <Empty>
            There is no gateway in front of this ledger. Every route is open, without sign-in, to
            anything that can reach its port.
          </Empty>
        ) : gateway.error ? (
          <Empty>{gateway.error.message}</Empty>
        ) : (gateway.data?.recentRefusals.length ?? 0) === 0 ? (
          <Empty>Nothing has been refused since the gateway started.</Empty>
        ) : (
          <>
            <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-dim)" }}>
              {refusedByReason.map(([reason, n]) => `${reason} × ${n}`).join(" · ")}
            </div>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Caller</th>
                  <th>Request</th>
                  <th>Answer</th>
                  <th>What was found</th>
                </tr>
              </thead>
              <tbody>
                {gateway.data?.recentRefusals.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td className="mono" title={formatTime(r.at)}>
                      {relativeTime(r.at)}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {r.caller}
                      <div style={{ color: "var(--text-faint)" }}>{r.ip}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {r.method} {r.path}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {r.status} {r.reason}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{detailText(r.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}
