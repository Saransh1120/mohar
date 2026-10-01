import { useEffect, useRef, useState } from "react";
import type { StreamState } from "./useEventStream";

/**
 * ── Alerts, heard rather than polled for ─────────────────────────────────────
 *
 * `EventSource` over the ledger's `/alerts/stream`. The stream says only that
 * the alert summary changed - one was raised, or one was acknowledged - and the
 * page then reads the alerts the way it always has. So a dropped stream costs
 * promptness and nothing else: the page keeps its slow poll underneath, and the
 * returned state lets it say which of the two it is running on.
 */
export function useAlertStream(onChange: () => void): StreamState {
  const [state, setState] = useState<StreamState>("connecting");

  // Passed inline by the caller, so a new function each render; held in a ref
  // so it cannot tear down a working stream.
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    // The first frame is the summary as it stands, which the page has already
    // loaded for itself; only what follows is news.
    let primed = false;

    try {
      es = new EventSource("/api/alerts/stream");
    } catch {
      setState("down");
      return;
    }

    es.addEventListener("open", () => !closed && setState("live"));
    es.addEventListener("alerts", () => {
      if (closed) return;
      setState("live");
      if (primed) cb.current();
      primed = true;
    });
    // EventSource retries on its own; after a reconnect the first frame may
    // well be news, so it is treated as such.
    es.onerror = () => {
      if (closed) return;
      setState("down");
      primed = true;
    };

    return () => {
      closed = true;
      es?.close();
    };
  }, []);

  return state;
}
