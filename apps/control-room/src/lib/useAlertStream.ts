import { useEffect, useRef, useState } from "react";
import { streamUrl } from "./api";
import type { StreamState } from "./useEventStream";

/** How long to wait before opening a stream again after it dropped. */
const REOPEN_MS = 3000;

/**
 * ── Alerts, heard rather than polled for ─────────────────────────────────────
 *
 * `EventSource` over the ledger's `/alerts/stream`. The stream says only that
 * the alert summary changed - one was raised, or one was acknowledged - and the
 * page then reads the alerts the way it always has. So a dropped stream costs
 * promptness and nothing else: the page keeps its slow poll underneath, and the
 * returned state lets it say which of the two it is running on.
 *
 * The stream is opened with a ticket from the gateway, and a ticket opens one
 * stream. The browser's own retry would present the spent one, so a stream
 * that drops is closed and opened again here with a new ticket.
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
    let retry: ReturnType<typeof setTimeout> | undefined;
    // The first frame is the summary as it stands, which the page has already
    // loaded for itself; only what follows is news.
    let primed = false;

    const reopen = () => {
      if (closed) return;
      setState("down");
      // After a reconnect the first frame may well be news, so it is treated
      // as such.
      primed = true;
      es?.close();
      es = null;
      clearTimeout(retry);
      retry = setTimeout(() => void open(), REOPEN_MS);
    };

    const open = async () => {
      let url: string;
      try {
        url = await streamUrl("/alerts/stream");
      } catch {
        return reopen();
      }
      if (closed) return;
      try {
        es = new EventSource(url);
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
      es.onerror = reopen;
    };

    void open();

    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  return state;
}
