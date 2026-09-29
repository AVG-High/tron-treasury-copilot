import { afterEach, expect, it, vi } from "vitest";
import { readHistory } from "../src/client/history";
afterEach(() => vi.unstubAllGlobals());
it("distinguishes absent history from corrupt empty history without writing either", () => {
  const setItem = vi.fn();
  const getItem = vi.fn((): string | null => null);
  vi.stubGlobal("localStorage", { getItem, setItem });
  expect(readHistory().error).toBeNull();
  getItem.mockReturnValue("");
  expect(readHistory().error).toBeTruthy();
  expect(setItem).not.toHaveBeenCalled();
});
