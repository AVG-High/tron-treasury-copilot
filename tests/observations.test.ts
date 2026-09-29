import { describe, it, expect } from "vitest";
import {
  appendObservation,
  OBSERVATION_KEY,
  readObservations,
} from "../src/client/observations";
import type { WalletState } from "../src/domain/types";
const now = Date.parse("2026-09-28T12:00:00Z");
function storage(raw?: string) {
  const values = new Map<string, string>(
    raw !== undefined ? [[OBSERVATION_KEY, raw]] : [],
  );
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function wallet(at = now): WalletState {
  return {
    address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    network: "tron-mainnet",
    usdt: "10000.000001",
    usdd: null,
    trx: "20",
    energyRemaining: 0,
    bandwidthRemaining: 0,
    positions: [],
    hasBorrow: false,
    fetchedAt: new Date(at).toISOString(),
    warnings: [],
  };
}
describe("wallet observation persistence", () => {
  it("preserves unknown USDD and exact amounts while deduplicating stale responses", () => {
    const db = storage();
    appendObservation(wallet(), db, now);
    appendObservation(wallet(), db, now);
    appendObservation(wallet(now - 1000), db, now);
    const journal = readObservations(db);
    expect(journal.wallets).toHaveLength(1);
    expect(journal.wallets[0].usdd).toBeNull();
    expect(journal.wallets[0].usdt).toBe("10000.000001");
  });
  it("retains corrupted raw data and rejects future or invalid snapshots", () => {
    const db = storage("broken original");
    expect(readObservations(db).error).toBeTruthy();
    expect(() => appendObservation(wallet(), db, now)).toThrow();
    expect(db.getItem(OBSERVATION_KEY)).toBe("broken original");
    const empty = storage("");
    expect(readObservations(empty).error).toBeTruthy();
    expect(() => appendObservation(wallet(), empty, now)).toThrow();
    expect(empty.getItem(OBSERVATION_KEY)).toBe("");
    expect(() => appendObservation(wallet(now + 1), storage(), now)).toThrow();
    expect(() =>
      appendObservation(wallet(now - 300001), storage(), now),
    ).toThrow();
    expect(() =>
      appendObservation({ ...wallet(), usdt: "NaN" }, storage(), now),
    ).toThrow();
  });
  it("rejects duplicate positions and inconsistent underlying identities", () => {
    const p = {
      marketId: "justlend-usdt" as const,
      underlyingAmount: "20",
      underlyingAsset: "USDT" as const,
      jTokenBalanceRaw: "100",
      collateral: false,
    };
    expect(() =>
      appendObservation({ ...wallet(), positions: [p, p] }, storage(), now),
    ).toThrow();
    expect(() =>
      appendObservation(
        { ...wallet(), positions: [{ ...p, underlyingAsset: "USDD" }] },
        storage(),
        now,
      ),
    ).toThrow();
  });
  it("bounds the journal and reports storage failure without inventing success", () => {
    const db = storage();
    for (let i = 0; i < 110; i++)
      appendObservation(wallet(now + i * 1000), db, now + i * 1000);
    expect(readObservations(db).wallets).toHaveLength(96);
    expect(() =>
      appendObservation(
        wallet(),
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        now,
      ),
    ).toThrow("quota");
  });
});
