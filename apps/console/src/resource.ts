import { useEffect, useRef, useState } from 'react';
import { ApiFailure } from './api.js';

export const POLL_INTERVAL_MS = 5_000;
const MAX_REQUESTS = 60;
const MAX_FAILURES = 5;
const MAX_DURATION_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 60_000;

interface Snapshot<T> { key: string; data?: T; error?: ApiFailure; loading: boolean; refreshing: boolean; updatedAt?: number; paused: boolean; }
export type Resource<T> = Omit<Snapshot<T>, 'key'> & { refresh: () => void };

/** One in-flight request per mounted resource, with finite polling and cancellation. */
export function useResource<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, poll: boolean | ((data: T) => boolean) = true): Resource<T> {
  const loadRef = useRef(loader); loadRef.current = loader;
  const pollRef = useRef(poll); pollRef.current = poll;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Snapshot<T>>({ key, loading: true, refreshing: false, paused: false });
  useEffect(() => {
    let disposed = false, inFlight = false, requests = 0, failures = 0, nextAllowedAt = 0, stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const controller = new AbortController();
    setState(previous => previous.key === key ? { ...previous, paused: false, error: undefined } : { key, loading: true, refreshing: false, paused: false });
    const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(() => { void run(); }, delay); };
    const run = async () => {
      if (disposed || inFlight || stopped) return;
      if (requests >= MAX_REQUESTS || failures >= MAX_FAILURES || Date.now() - startedAt >= MAX_DURATION_MS) {
        stopped = true; setState(s => ({ ...s, paused: true, loading: false, refreshing: false })); return;
      }
      if (document.hidden) { setState(s => ({ ...s, paused: true })); return; }
      if (Date.now() < nextAllowedAt) { schedule(nextAllowedAt - Date.now()); return; }
      inFlight = true; requests++;
      setState(s => ({ ...s, refreshing: true, paused: false }));
      let delay = POLL_INTERVAL_MS;
      try {
        const data = await loadRef.current(controller.signal);
        if (disposed) return;
        failures = 0;
        setState({ key, data, loading: false, refreshing: false, updatedAt: Date.now(), paused: false });
        stopped = typeof pollRef.current === 'function' ? !pollRef.current(data) : !pollRef.current;
      } catch (error) {
        if (disposed) return;
        const failure = error instanceof ApiFailure ? error : new ApiFailure('查询失败，请重试');
        failures++;
        stopped = !failure.retryable || pollRef.current === false;
        // Respect longer server delays by pausing rather than retrying early.
        if (failure.retryAfterMs > MAX_BACKOFF_MS) stopped = true;
        delay = Math.max(Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** failures), Math.min(MAX_BACKOFF_MS, failure.retryAfterMs));
        nextAllowedAt = Date.now() + delay;
        setState(s => ({ ...s, data: [401, 403, 404].includes(failure.status) ? undefined : s.data, error: failure, loading: false, refreshing: false, paused: stopped }));
      } finally { inFlight = false; }
      if (!disposed && !stopped) schedule(delay);
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) { setState(s => ({ ...s, paused: true })); }
      else if (!stopped) { void run(); }
    };
    document.addEventListener('visibilitychange', visibility);
    void run();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [key, revision]);
  const current = state.key === key ? state : { loading: true, refreshing: false, paused: false };
  return { ...current, refresh: () => setRevision(r => r + 1) };
}
