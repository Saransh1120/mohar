import { useState } from "react";
import { generateSeamLabel } from "@mohar/crypto-core";
import {
  api,
  type DemoOpening,
  type EngineCheck,
  type OfflineRuling,
  type OfflineTranscript,
  type StationCache,
} from "../lib/api";
import {
  assembleFromCache,
  buildTranscript,
  stationChecks,
  type OfflineInput,
} from "../lib/offlineOpening";
import { RoundNotPublished, type Station } from "../lib/openingStation";
import { Card } from "./ui";
import { CheckList, durationText, roleText, sha256OfFile } from "./CheckList";

/**
 * ── Opening with no link to the ledger ───────────────────────────────────────
 *
 * The station caches what it needs while the link is up, opens the packet on
 * its own, and tells the ledger afterwards. This card walks those three
 * moments apart so each can be seen: nothing between "cache" and "report" is a
 * call to the ledger.
 *
 * It also lets the station be made to misbehave. With its own checks switched
 * off it opens for one official, or for a wrong serial, as a tampered station
 * would. The packet opens either way, because nobody is there to refuse it;
 * what changes is the ledger's ruling when the account arrives.
 */

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type LabelChoice = "this" | "other" | "none";
type SecondChoice = "own" | "borrowed" | "absent";

export function OfflineOpening({
  run,
  station,
  onDone,
}: {
  run: DemoOpening;
  station: Station;
  onDone: () => void;
}) {
  const [cache, setCache] = useState<StationCache | null>(null);
  const [labelChoice, setLabelChoice] = useState<LabelChoice>("this");
  const [first, setFirst] = useState(run.officials[0]?.id ?? "");
  const [second, setSecond] = useState(run.officials[1]?.id ?? "");
  const [secondChoice, setSecondChoice] = useState<SecondChoice>("own");
  const [serial, setSerial] = useState(run.serial);
  const [enforce, setEnforce] = useState(true);
  const [photo, setPhoto] = useState<File | null>(null);

  const [local, setLocal] = useState<{ ok: boolean; title: string; checks: EngineCheck[] } | null>(null);
  const [pending, setPending] = useState<OfflineTranscript | null>(null);
  const [ruling, setRuling] = useState<OfflineRuling | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const msToOpen = cache ? Date.parse(cache.scheduledOpenAt) - Date.now() : 0;

  async function run_(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fetchCache = () =>
    run_(async () => {
      setCache(await api.stationCache(station.deviceId, run.packageId));
      setLocal(null);
      setPending(null);
      setRuling(null);
    });

  function presented(): OfflineInput {
    const slotOf = (personId: string) => cache?.officials.find((o) => o.personId === personId)?.slot ?? undefined;
    const now = Date.now();
    const officials: OfflineInput["officials"] = [];
    const one = slotOf(first);
    officials.push({
      personId: first,
      ...(one === undefined ? {} : { biometricSlot: one, biometricScore: 180 }),
      assertedAt: new Date(now - 6000).toISOString(),
    });
    if (secondChoice !== "absent" && second) {
      // "borrowed" presents the first official's finger for the second.
      const two = secondChoice === "borrowed" ? one : slotOf(second);
      officials.push({
        personId: second,
        ...(two === undefined ? {} : { biometricSlot: two, biometricScore: 176 }),
        assertedAt: new Date(now).toISOString(),
      });
    }
    let label: OfflineInput["label"];
    if (labelChoice === "this") label = run.label;
    else if (labelChoice === "other") {
      const other = generateSeamLabel();
      label = { seamId: other.seamId, shareAHex: toHex(other.shareA), shareBHex: toHex(other.shareB) };
    }
    return { ...(label ? { label } : {}), officials, packetSerialTyped: serial };
  }

  const open = () =>
    run_(async () => {
      if (!cache) return;
      const startedAt = new Date(Date.now() - 8000).toISOString();
      const input = presented();
      const checks = stationChecks(cache, input, new Date());
      const passed = checks.every((c) => c.passed !== false);
      setRuling(null);
      setPending(null);

      if (!passed && enforce) {
        setLocal({ ok: false, title: "THE STATION REFUSES — NOTHING IS OPENED", checks });
        return;
      }
      // Two shares assemble the key. A station that skips its checks still has
      // to unwrap two, whoever it did or did not see at the reader.
      const holders = [...new Set([...input.officials.map((o) => o.personId), ...cache.officials.map((o) => o.personId)])].slice(0, 2);
      let keyHex: string;
      try {
        keyHex = await assembleFromCache(station, cache, holders);
      } catch (e) {
        if (e instanceof RoundNotPublished) {
          setLocal({
            ok: false,
            title: "THE CONTROL ROOM'S PART IS STILL LOCKED",
            checks: [
              ...checks,
              {
                check: "round_published",
                passed: false,
                evidence: `${(e as Error).message}. No cache opens it before then, with or without the ledger.`,
              },
            ],
          });
          return;
        }
        throw e;
      }
      setLocal({
        ok: true,
        title: passed ? "OPENED BY THE STATION — NOT YET REPORTED" : "OPENED WITH THE STATION'S CHECKS OFF — NOT YET REPORTED",
        checks,
      });
      setPending(buildTranscript(station, cache, input, keyHex, startedAt));
    });

  const report = () =>
    run_(async () => {
      if (!pending) return;
      const transcript = photo ? { ...pending, photoSha256: await sha256OfFile(photo) } : pending;
      setRuling(await api.offlineOpening(transcript));
      onDone();
    });

  return (
    <Card title="Opening with no link to the ledger" hint="envelope-authorized">
      <div className="note" style={{ marginBottom: 12 }}>
        The station caches the envelope and the wrapped shares while it can reach the ledger, opens
        the packet on its own, and reports afterwards. <strong>The checks in the middle are the
        station's own</strong>; the ledger rules on the account when it arrives.{" "}
        <strong>The time lock is not the station's</strong>: the round still has to be published,
        and here it is fetched from a public relay. Fingerprint input is simulated.
      </div>

      <button disabled={busy} onClick={() => void fetchCache()}>
        {cache ? "Fetch the cache again" : "1 · Cache this packet while the link is up"}
      </button>

      {cache && (
        <>
          <dl className="kv" style={{ margin: "12px 0" }}>
            <dt>Cached</dt>
            <dd>
              envelope for round {cache.drandRound}, {cache.officials.length} wrapped shares, issue{" "}
              {cache.issueNo}
            </dd>
            <dt>Control part</dt>
            <dd>{msToOpen > 0 ? `locked, opens in ${durationText(msToOpen / 1000)}` : "its round has been published"}</dd>
          </dl>

          <div className="form">
            <label>Label scanned</label>
            <select value={labelChoice} onChange={(e) => setLabelChoice(e.target.value as LabelChoice)}>
              <option value="this">this packet's label, both codes</option>
              <option value="other">a label from another packet</option>
              <option value="none">not scanned</option>
            </select>
            <label>First official</label>
            <select value={first} onChange={(e) => setFirst(e.target.value)}>
              {cache.officials.map((o) => (
                <option key={o.personId} value={o.personId}>
                  {o.name} ({roleText(o.holder)})
                </option>
              ))}
            </select>
            <label>Second official</label>
            <select value={second} onChange={(e) => setSecond(e.target.value)}>
              {cache.officials.map((o) => (
                <option key={o.personId} value={o.personId}>
                  {o.name} ({roleText(o.holder)})
                </option>
              ))}
            </select>
            <label>Second finger</label>
            <select value={secondChoice} onChange={(e) => setSecondChoice(e.target.value as SecondChoice)}>
              <option value="own">their own</option>
              <option value="borrowed">the first official's finger</option>
              <option value="absent">nobody: one official alone</option>
            </select>
            <label>Serial typed</label>
            <input type="text" value={serial} onChange={(e) => setSerial(e.target.value)} />
          </div>

          <label style={{ display: "block", fontSize: 12, margin: "10px 0" }}>
            <input type="checkbox" checked={!enforce} onChange={(e) => setEnforce(!e.target.checked)} /> Switch
            the station's own checks off, as a tampered station would
          </label>

          <button className="primary" disabled={busy || !first} onClick={() => void open()}>
            {busy ? "…" : "2 · Open with no link to the ledger"}
          </button>
        </>
      )}

      {local && (
        <div style={{ marginTop: 14 }}>
          <div className={local.ok ? "verdict granted" : "verdict denied"}>{local.title}</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", margin: "8px 0" }}>
            The station's own ruling. The ledger has not been told anything yet.
          </div>
          <CheckList checks={local.checks} />
        </div>
      )}

      {pending && !ruling && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
            Photograph of the opened packet, if one was taken:
          </div>
          <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          <div>
            <button className="primary" style={{ marginTop: 10 }} disabled={busy} onClick={() => void report()}>
              {busy ? "…" : "3 · The link is back: report the opening"}
            </button>
          </div>
        </div>
      )}

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}

      {ruling && (
        <div style={{ marginTop: 14 }}>
          <div className={ruling.outcome === "accepted" ? "verdict granted" : "verdict denied"}>
            THE LEDGER'S RULING: {ruling.outcome === "accepted" ? "ACCEPTED" : "DISPUTED"}
            {ruling.duplicate && " (ALREADY ON RECORD)"}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", margin: "8px 0" }}>
            {ruling.outcome === "accepted"
              ? "Every step of the station's account passed the checks the live path applies. It is on record as envelope-authorized."
              : `The account fails: ${ruling.denyReasons.join(", ")}. The packet is open regardless; an alert has been raised for the control room.`}
          </div>
          {ruling.steps.map((s, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                <span className="mono">{s.step}</span>{" "}
                <span className={`badge ${s.outcome === "passed" ? "ok" : "critical"}`}>{s.outcome}</span>
              </div>
              <CheckList checks={s.checks} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
