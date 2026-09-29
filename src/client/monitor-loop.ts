export interface MonitorLoopOptions<T> {
  intervalMs: number;
  load: () => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown, consecutiveFailures: number) => void;
  onStop: () => void;
  isVisible: () => boolean;
}

/** One read at a time. Stopping invalidates in-flight results; nothing here submits transactions. */
export function startMonitorLoop<T>(
  options: MonitorLoopOptions<T>,
): () => void {
  if (![60_000, 300_000, 900_000].includes(options.intervalMs))
    throw new Error("지원하지 않는 관측 주기입니다.");
  let alive = true;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    if (!alive) return;
    if (!options.isVisible()) {
      timer = setTimeout(tick, options.intervalMs);
      return;
    }
    try {
      const value = await options.load();
      if (!alive) return;
      options.onValue(value);
      failures = 0;
    } catch (error) {
      if (!alive) return;
      failures++;
      options.onError(error, failures);
      if (failures >= 3) {
        alive = false;
        options.onStop();
        return;
      }
    }
    if (alive)
      timer = setTimeout(
        tick,
        Math.min(900_000, options.intervalMs * 2 ** failures),
      );
  }
  void tick();
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
  };
}
