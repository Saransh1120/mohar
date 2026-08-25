import { useEffect, useRef, useState } from "react";

/**
 * ── Live chain events, pushed rather than polled ─────────────────────────────
 *
 * `EventSource` over the ledger's `/events/stream`. Server-Sent Events rather
 * than a WebSocket because nothing here ever travels browser-to-server: the
 * page asks once and then only listens. What SSE adds for free is the part that
 * matters in a hall running off a phone hotspot — the browser reconnects on its
 * own, and sends back `Last-Event-ID` so the stream resumes at the sequence it
 * actually reached rather than restarting or, worse, silently skipping.
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

    try {
      es = new EventSource(`/api/events/stream?afterSeq=${encodeURIComponent(afterSeq)}`);
    } catch {
      setState("down");
      return;
    }

    es.addEventListener("open", () => !closed && setState("live"));

    es.addEventListener("event", (ev) => {
      if (closed) return;
      setState("live");
      try {
        cb.current(JSON.parse((ev as MessageEvent).data) as ChainEvent);
      } catch {
        // A malformed frame is not worth tearing the stream down for. The
        // sequence continues, and anything missed is still reachable through
        // the polling endpoint.
      }
    });

    // EventSource retries on its own; this fires each time the link drops. The
    // page shows "reconnecting" rather than pretending the feed is current,
    // because a stale feed that looks live is worse than one that admits it.
    es.onerror = () => !closed && setState("down");

    return () => {
      closed = true;
      es?.close();
    };
  }, [enabled, afterSeq]);

  return state;
}
