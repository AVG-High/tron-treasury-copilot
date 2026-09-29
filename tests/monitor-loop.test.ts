import { afterEach, describe, expect, it, vi } from "vitest";
import { startMonitorLoop } from "../src/client/monitor-loop";
afterEach(() => vi.useRealTimers());
function setup(load = vi.fn(async () => "snapshot")) {
  return {
    intervalMs: 60000,
    load,
    onValue: vi.fn(),
    onError: vi.fn(),
    onStop: vi.fn(),
    isVisible: vi.fn(() => true),
  };
}
describe("read-only polling lifecycle", () => {
  it("waits for the prior read before scheduling and discards a late result after stop", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const config = setup(
      vi.fn(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      ),
    );
    const stop = startMonitorLoop(config);
    await vi.advanceTimersByTimeAsync(900000);
    expect(config.load).toHaveBeenCalledTimes(1);
    stop();
    resolve("late snapshot");
    await vi.advanceTimersByTimeAsync(0);
    expect(config.onValue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("backs off twice then stops on the third failure", async () => {
    vi.useFakeTimers();
    const config = setup(
      vi.fn(async () => {
        throw new Error("rate limit");
      }),
    );
    startMonitorLoop(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(config.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119999);
    expect(config.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(config.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(240000);
    expect(config.load).toHaveBeenCalledTimes(3);
    expect(config.onStop).toHaveBeenCalledTimes(1);
    expect(config.onValue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses while backgrounded and resets backoff following a successful read", async () => {
    vi.useFakeTimers();
    const config = setup(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValue("fresh"),
    );
    config.isVisible.mockReturnValue(false);
    const stop = startMonitorLoop(config);
    await vi.advanceTimersByTimeAsync(120000);
    expect(config.load).not.toHaveBeenCalled();
    config.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(config.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(config.onValue).toHaveBeenCalledWith("fresh");
    await vi.advanceTimersByTimeAsync(60000);
    expect(config.load).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
