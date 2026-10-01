import { useEffect, useRef, useState } from "react";
import { streamUrl } from "./api";

/**
 * ── Live chain events, pushed rather than polled ─────────────────────────────
 *
 * `EventSource` over the ledger's `/events/stream`. Server-Sent Events rather
 * than a WebSocket because nothing here ever travels browser-to-server: the
 * page asks once and then only listens.
 *
 * The stream is opened with a ticket from the gateway, and a ticket opens one
 * stream, so the browser's own reconnect cannot be used: it would present the
 * spent ticket. A stream that drops is closed and opened again here, with a new
 * ticket and from the sequence it actually reached, so it resumes rather than
 * restarting or, worse, silently skipping.
 *
 * The hook deliberately does not own the data. It hands each event to a
 * callback and reports whether the link is up; what to keep and how to render
 * it belongs to the page. That also means a page can use this and still fall
 * back to `GET /events?afterSeq=` — the cursor is the same chain sequence, so
 * the two are interchangeable and a dead stream degrades to a slower feed
 * rather than a blank one.
 */

export interface ChainEvent {
  seq: string;
  id: string;
  kind: string;
  body: { payload?: unknown; actorDeviceId?: string; [k: string]: unknown };
  occurred_at: string;
  received_at: string;
  hash: string;
}

export type StreamState = "connecting" | "live" | "down";

/** How long to wait before opening a stream again after it dropped. */
const REOPEN_MS = 3000;

export function useEventStream(
  onEvent: (e: ChainEvent) => void,
  opts: { afterSeq?: string; enabled?: boolean } = {},
): StreamState {
  const [state, setState] = useState<StreamState>("connecting");

  // The callback is passed inline by every caller, so it is a new function on
  // each render. Held in a ref, it cannot retrigger the effect and tear down a
  // working stream on every parent re-render.
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  }, [onEvent]);

  const enabled = opts.enabled ?? true;
  const afterSeq = opts.afterSeq ?? "0";

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Where the stream has got to. A reopened stream starts from here.
    let cursor = afterSeq;

    // This fires each time the link drops. The page shows "reconnecting"
    // rather than pretending the feed is current, because a stale feed that
    // looks live is worse than one that admits it.
    const reopen = () => {
      if (closed) return;
      setState("down");
      es?.close();
      es = null;
      clearTimeout(retry);
      retry = setTimeout(() => void open(), REOPEN_MS);
    };

    const open = async () => {
      let url: string;
      try {
        url = await streamUrl("/events/stream", { afterSeq: cursor });
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

      es.addEventListener("event", (ev) => {
        if (closed) return;
        setState("live");
        try {
          const event = JSON.parse((ev as MessageEvent).data) as ChainEvent;
          cursor = String(event.seq);
          cb.current(event);
        } catch {
          // A malformed frame is not worth tearing the stream down for. The
          // sequence continues, and anything missed is still reachable through
          // the polling endpoint.
        }
      });

      es.onerror = reopen;
    };

    void open();

    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [enabled, afterSeq]);

  return state;
}
