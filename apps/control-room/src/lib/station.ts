/**
 * ── Talking to the station directly ──────────────────────────────────────────
 *
 * Everything else in this app reads the ledger. This one module does not: it
 * speaks to the ESP32 on the exam-hall LAN, because enrolling a finger is an
 * instruction to a specific reader in a specific room and there is nothing in
 * the chain that could carry it.
 *
 * The distinction is worth keeping sharp. Nothing here is evidence. The station
 * signs its own records with the key in its flash, and this endpoint cannot
 * sign, cannot reach the ledger, and holds no key — it manages templates on the
 * reader in front of you and nothing more. If this module went away entirely,
 * every claim the system makes would still stand.
 */

const STORAGE_KEY = "mohar.station.url";

export interface StationStatus {
  deviceId: string;
  reader: boolean;
  templates: number;
  capacity: number;
  enrol: {
    state: "idle" | "place_finger" | "lift_finger" | "place_again" | "stored" | "failed";
    slot: number;
    message: string;
  };
  ceremony: { active: boolean; assertions: number; windowSeconds: number };
  /** The package this station is configured to witness. Empty if unset. */
  packageId: string;
  centreId: string;
  /** Where the station is currently sending records, and the address it answers on. */
  ledgerUrl: string;
  ip: string;
  pending: number;
  observerSlotMin: number;
}

export function loadStationUrl(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function saveStationUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, normalise(url));
}

/** Accept "10.0.0.5", "10.0.0.5:80" or a full URL and produce a base URL. */
export function normalise(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

/**
 * Long enough for the link the station is actually on.
 *
 * This was three seconds, on the reasoning that a LAN device answers in
 * milliseconds. Measured against the real board over a phone hotspot: 0.2 s at
 * best, 2.9 s at worst, on consecutive polls. Three seconds was therefore
 * reporting a healthy station as absent roughly whenever the link was busy.
 * Eight seconds still fails fast enough to be useful about a wrong address, and
 * stops calling a slow hop a dead device.
 */
const TIMEOUT_MS = 8000;

/**
 * One request to the station at a time.
 *
 * The ESP32's WebServer serves a single connection at a time, so overlapping
 * calls queue on the device and each one's clock keeps running while it waits.
 * Two pollers — which is what React's StrictMode double-mount produces in dev —
 * turn a 1-second response into a 2-second one and push it towards the timeout.
 * Concurrent status reads are collapsed into the one already running.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function call<T>(base: string, path: string, method: "GET" | "POST"): Promise<T> {
  if (method === "GET") {
    const key = base + path;
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = dial<T>(base, path, method).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }
  return dial<T>(base, path, method);
}

async function dial<T>(base: string, path: string, method: "GET" | "POST"): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base + path, { method, signal: ctl.signal });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${method} ${path} → ${res.status}`);
    return body;
  } catch (err) {
    const e = err as Error;
    // Always name the address that was tried. Almost every failure here is a
    // wrong or stale address — a hotspot hands out a new subnet on every
    // restart — and an error that does not say what it dialled leaves the
    // operator checking the device when the device was never the problem.
    if (e.name === "AbortError") {
      throw new Error(
        `No answer from ${base} within ${TIMEOUT_MS / 1000} seconds. Check that address is current — ` +
          "the station prints its address at boot, and announces it into the chain as " +
          "station_online — and that the device is powered.",
      );
    }
    // A browser blocks cross-origin failures without saying why, so name the
    // two causes that actually occur rather than surfacing "Failed to fetch".
    if (e.message === "Failed to fetch") {
      throw new Error(
        `Could not reach ${base}. It must be on the same network as this machine, ` +
          "and this page must be served over http — a page on https cannot call it.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const station = {
  status: (base: string) => call<StationStatus>(base, "/status", "GET"),
  enrol: (base: string, slot: number) =>
    call<{ status: string; slot: number }>(base, `/enrol?slot=${slot}`, "POST"),
  cancel: (base: string) => call<{ status: string }>(base, "/enrol/cancel", "POST"),
  /**
   * Point the station at a different ledger.
   *
   * A phone hotspot hands out a new subnet every time it restarts, so the
   * address the station was flashed with is wrong again within a day. This is
   * the difference between a thirty-second fix and re-flashing a device in the
   * hour before an exam.
   */
  setLedger: (base: string, ledgerUrl: string) =>
    call<{ status: string; ledgerUrl: string }>(
      base,
      `/config?ledger=${encodeURIComponent(ledgerUrl)}`,
      "POST",
    ),
  deleteSlot: (base: string, slot: number) =>
    call<{ status: string }>(base, `/slot/delete?slot=${slot}`, "POST"),
};

/** What to tell the person standing at the reader, for each machine state. */
export function enrolInstruction(state: StationStatus["enrol"]["state"]): string {
  switch (state) {
    case "place_finger":
      return "Place the finger on the reader and hold it until it moves on";
    case "lift_finger":
      return "Lift the finger";
    case "place_again":
      return "Place the same finger again, the same way";
    case "stored":
      return "Stored on the reader. Now register who this slot is, below.";
    case "failed":
      return "Enrolment failed";
    default:
      return "Idle";
  }
}
