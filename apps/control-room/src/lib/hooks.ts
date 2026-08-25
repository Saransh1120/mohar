import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fetch-on-mount with manual and interval refresh.
 *
 * Polling rather than websockets: the ledger has no change stream yet, and a
 * control room refreshing every few seconds is well within what the service
 * handles at pilot scale. When `notify` exists this becomes a subscription.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  opts: { pollMs?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  // Keeps the latest fn without making it a dependency of the effect, so a
  // caller passing an inline closure does not cause a refetch every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void run();
    if (!opts.pollMs) return;
    const t = setInterval(() => void run(), opts.pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.pollMs, run]);

  return { data, error, loading, refresh: run };
}

/** "4m ago" / "2h ago" — absolute timestamps are kept in a tooltip. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const future = diffMs < 0;
  const s = Math.abs(diffMs) / 1000;
  const fmt =
    s < 60 ? `${Math.round(s)}s` :
    s < 3600 ? `${Math.round(s / 60)}m` :
    s < 86400 ? `${Math.round(s / 3600)}h` :
    `${Math.round(s / 86400)}d`;
  return future ? `in ${fmt}` : `${fmt} ago`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
