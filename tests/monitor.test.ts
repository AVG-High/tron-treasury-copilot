import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultCosts,
  defaultIntent,
  demoSnapshot,
} from "../src/domain/fixtures";
import { monitorPlan, compareWalletObservations } from "../src/domain/monitor";
import { planTreasury } from "../src/domain/planner";
import type { MarketSnapshot, WalletState } from "../src/domain/types";

const SAVED = "2026-09-20T12:00:00.000Z";
const NOW = "2026-09-28T12:00:00.000Z";
const shift = (date: string, milliseconds: number) =>
  new Date(Date.parse(date) + milliseconds).toISOString();
function live(at = NOW): MarketSnapshot {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.mode = "live";
  snapshot.fetchedAt = at;
  for (const market of snapshot.markets) {
    market.quality = "verified";
    for (const evidence of market.evidence) evidence.fetchedAt = at;
  }
  for (const evidence of snapshot.psm.evidence) evidence.fetchedAt = at;
  return snapshot;
}
function original() {
  return planTreasury(
    { ...structuredClone(defaultIntent), maxUSDDExposurePct: 0 },
    live(SAVED),
    { ...defaultCosts },
  );
}
function wallet(at = NOW): WalletState {
  return {
    address: "test-only-owner",
    network: "tron-mainnet",
    usdt: "4504",
    usdd: null,
    trx: "20",
    energyRemaining: 0,
    bandwidthRemaining: 0,
    positions: [
      {
        marketId: "justlend-usdt",
        underlyingAmount: "5496",
        underlyingAsset: "USDT",
        jTokenBalanceRaw: "123456000000",
        collateral: false,
      },
    ],
    hasBorrow: false,
    fetchedAt: at,
    warnings: [],
  };
}
function inputs() {
  return {
    original: original(),
    selectedPlanId: "yield",
    savedAt: SAVED,
    snapshot: live(),
    wallet: wallet(),
    now: NOW,
  };
}
const codes = (result: ReturnType<typeof monitorPlan>) =>
  result.alerts.map((alert) => alert.code);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SAVED));
});
afterEach(() => vi.useRealTimers());

describe("read-only original-plan monitoring", () => {
  it("advances whole UTC days without spending overdue reservations or replacing capital with wallet balances", () => {
    const input = inputs();
    const result = monitorPlan(input);
    expect(result.elapsedDays).toBe(8);
    expect(result.remainingDays).toBe(22);
    expect(
      result.remainingIntent?.expenses.map((expense) => expense.dueInDays),
    ).toEqual([0, 22]);
    expect(result.proposal?.intent.capitalUSDT).toBe("10000");
    expect(result.proposal?.intent.emergencyUSDT).toBe("500");
    expect(result.proposal?.intent.expenses[0].amountUSDT).toBe("3000");
    expect(result.proposal?.executable).toBe(false);
    expect(result.proposal?.requiresReview).toBe(true);
    expect(result.reserve).toEqual({
      requiredUSDT: "4504.000000",
      walletUSDT: "4504.000000",
      shortfallUSDT: "0.000000",
    });
    expect(codes(result)).toContain("expense-due:payroll");
    expect(result.actualNetYieldUSDT).toBeNull();
  });

  it("compares unchanged rates at the SAME original principal and horizon, not a smaller remaining-horizon allocation", () => {
    const input = inputs();
    const result = monitorPlan(input);
    const comparison = result.rateComparisons[0];
    expect(comparison.principalUSDT).toBe(
      input.original.plans.find((plan) => plan.id === "yield")!.investedUSDT,
    );
    expect(comparison.originalHorizonDays).toBe(30);
    expect(comparison.deltaBaseYieldUSDT).toBe("0.000000");
    expect(comparison.originalBaseYieldUSDT).toBe(
      input.original.plans.find((plan) => plan.id === "yield")!.grossYieldUSDT,
    );
  });

  it("retains a genuine 0 APY and shows its negative projection delta", () => {
    const input = inputs();
    input.snapshot.markets[0].baseApy = "0";
    const result = monitorPlan(input);
    const comparison = result.rateComparisons[0];
    expect(comparison.currentBaseApy).toBe("0");
    expect(comparison.currentBaseYieldUSDT).toBe("0.000000");
    expect(
      new Decimal(comparison.deltaBaseYieldUSDT!).eq(
        new Decimal(comparison.originalBaseYieldUSDT!).negated(),
      ),
    ).toBe(true);
    expect(codes(result)).toContain("base-rate-changed");
    expect(codes(result)).not.toContain("market-unavailable");
  });

  it("does not convert missing APY, stale evidence, duplicate markets or changed token identity into zero yield", () => {
    for (const mode of [
      "missing",
      "stale-evidence",
      "duplicate",
      "identity",
    ] as const) {
      const input = inputs();
      if (mode === "missing") input.snapshot.markets[0].baseApy = null;
      if (mode === "stale-evidence")
        input.snapshot.markets[0].evidence[0].fetchedAt = SAVED;
      if (mode === "duplicate")
        input.snapshot.markets.push(structuredClone(input.snapshot.markets[0]));
      if (mode === "identity")
        input.snapshot.markets[0].tokenAddress = "different-test-token";
      const result = monitorPlan(input);
      expect(result.rateComparisons[0].currentBaseApy).toBeNull();
      expect(result.rateComparisons[0].deltaBaseYieldUSDT).toBeNull();
      expect(codes(result)).toContain("market-unavailable");
      if (mode === "identity")
        expect(codes(result)).toContain("market-identity-changed");
    }
  });

  it("verifies the historic source at its original time, allowing an old valid baseline but rejecting original missing provenance", () => {
    const input = inputs();
    expect(monitorPlan(input).rateComparisons[0].originalBaseApy).toBe("0.058");
    input.original.snapshot.markets[0].evidence = [];
    const result = monitorPlan(input);
    expect(result.rateComparisons[0].originalBaseApy).toBeNull();
    expect(result.rateComparisons[0].currentBaseApy).toBe("0.058");
    expect(result.rateComparisons[0].deltaBaseYieldUSDT).toBeNull();
    expect(codes(result)).toContain("original-rate-unavailable");
  });

  it("handles multiple JustLend assets without aggregating USDD observations into a USDT balance", () => {
    const input = inputs();
    input.original = planTreasury(structuredClone(defaultIntent), live(SAVED), {
      ...defaultCosts,
      justlendUsddRoundTripUSDT: "0",
    });
    input.wallet.positions.push({
      marketId: "justlend-usdd",
      underlyingAmount: "2000.000000000000000001",
      underlyingAsset: "USDD",
      jTokenBalanceRaw: "333",
      collateral: false,
    });
    input.snapshot.markets[1].cashUSDT = "2000";
    input.snapshot.markets[1].baseApy = "0.2";
    const result = monitorPlan(input);
    expect(
      new Set(result.rateComparisons.map((row) => row.strategy)).size,
    ).toBe(2);
    expect(result.reserve?.walletUSDT).toBe("4504.000000");
    expect(
      result.alerts.some(
        (alert) =>
          alert.code === "exit-liquidity-shortfall" &&
          alert.strategy === "justlend-usdd",
      ),
    ).toBe(true);
    expect(
      result.rateComparisons.find((row) => row.strategy === "justlend-usdt")
        ?.deltaBaseYieldUSDT,
    ).toBe("0.000000");
  });

  it("compares full expense/emergency/cost reservation to USDT and warns on borrowing", () => {
    const input = inputs();
    input.wallet.usdt = "4503.999999";
    input.wallet.hasBorrow = true;
    const result = monitorPlan(input);
    expect(result.reserve?.shortfallUSDT).toBe("0.000001");
    expect(codes(result)).toContain("reserve-shortfall");
    expect(codes(result)).toContain("borrow-restriction");
  });

  it("warns separately for observed market cash shortage and unavailable cash", () => {
    const input = inputs();
    input.snapshot.markets[0].cashUSDT = "5495.999999";
    expect(codes(monitorPlan(input))).toContain("exit-liquidity-shortfall");
    input.snapshot.markets[0].cashUSDT = null;
    const result = monitorPlan(input);
    expect(codes(result)).toContain("exit-liquidity-unavailable");
    expect(codes(result)).not.toContain("exit-liquidity-shortfall");
  });

  it("blocks current comparisons and proposals for stale, future or demo market snapshots", () => {
    for (const fetchedAt of [
      shift(NOW, -300_001),
      shift(NOW, 30_001),
      "invalid",
    ]) {
      const input = inputs();
      input.snapshot.fetchedAt = fetchedAt;
      const result = monitorPlan(input);
      expect(result.proposal).toBeNull();
      expect(result.rateComparisons[0].currentBaseYieldUSDT).toBeNull();
      expect(codes(result)).toContain("stale-market-snapshot");
    }
    const input = inputs();
    input.snapshot.mode = "demo";
    expect(codes(monitorPlan(input))).toContain("live-data-required");
    expect(monitorPlan(input).proposal).toBeNull();
  });

  it("keeps current wallet comparisons unknown for stale, future, duplicate or malformed positions", () => {
    for (const variant of [
      "stale",
      "future",
      "duplicate",
      "asset",
      "balance",
    ] as const) {
      const input = inputs();
      if (variant === "stale") input.wallet.fetchedAt = SAVED;
      if (variant === "future") input.wallet.fetchedAt = shift(NOW, 30_001);
      if (variant === "duplicate")
        input.wallet.positions.push(structuredClone(input.wallet.positions[0]));
      if (variant === "asset")
        input.wallet.positions[0].underlyingAsset = "USDD";
      if (variant === "balance") input.wallet.usdt = "NaN";
      const result = monitorPlan(input);
      expect(result.reserve?.walletUSDT).toBeNull();
      expect(result.reserve?.shortfallUSDT).toBeNull();
      expect(codes(result)).toContain("wallet-unavailable");
    }
  });

  it("does not reset an expired horizon, infer paid expenses or create a future-dated proposal", () => {
    const input = inputs();
    input.now = shift(SAVED, 31 * 86_400_000);
    input.snapshot = live(input.now);
    input.wallet = wallet(input.now);
    const result = monitorPlan(input);
    expect(result.remainingDays).toBe(0);
    expect(result.remainingIntent).toBeNull();
    expect(result.proposal).toBeNull();
    expect(result.reserve?.requiredUSDT).toBe("4504.000000");
    expect(codes(result)).toContain("horizon-expired");
    input.savedAt = shift(input.now, 30_001);
    const future = monitorPlan(input);
    expect(future.elapsedDays).toBeNull();
    expect(future.proposal).toBeNull();
    expect(codes(future)).toContain("invalid-plan-time");
  });

  it("rejects a future original creation time or a save preceding creation", () => {
    const input = inputs();
    input.original.createdAt = shift(NOW, 30_001);
    expect(monitorPlan(input).proposal).toBeNull();
    expect(codes(monitorPlan(input))).toContain("invalid-plan-time");
    input.original.createdAt = shift(SAVED, 30_001);
    expect(codes(monitorPlan(input))).toContain("invalid-plan-time");
  });

  it("does not equate JustLend USDD market cash with available USDT on exit", () => {
    const input = inputs();
    input.wallet.positions.push({
      marketId: "justlend-usdd",
      underlyingAmount: "1",
      underlyingAsset: "USDD",
      jTokenBalanceRaw: "1",
      collateral: false,
    });
    input.snapshot.psm.available = false;
    expect(codes(monitorPlan(input))).toContain("usdd-exit-unavailable");
  });

  it("does not consume a day merely by crossing a UTC midnight", () => {
    const input = inputs();
    input.savedAt = shift(NOW, -86_399_999);
    expect(monitorPlan(input).elapsedDays).toBe(0);
    input.savedAt = shift(NOW, -86_400_000);
    expect(monitorPlan(input).elapsedDays).toBe(1);
  });

  it("warns before upcoming deadlines and preserves absent-wallet quality", () => {
    const input = { ...inputs(), wallet: null };
    input.savedAt = shift(NOW, -4 * 86_400_000);
    const result = monitorPlan(input);
    expect(codes(result)).toContain("expense-soon:payroll");
    expect(codes(result)).toContain("wallet-not-observed");
    expect(result.reserve?.shortfallUSDT).toBeNull();
  });

  it("keeps incentives separate and signals their changing or missing rates", () => {
    const input = inputs();
    input.original.costs.includeIncentives = true;
    input.snapshot.markets[0].rewardApy = "0";
    const changed = monitorPlan(input);
    expect(codes(changed)).toContain("incentive-rate-changed");
    expect(changed.rateComparisons[0].deltaBaseYieldUSDT).toBe("0.000000");
    input.snapshot.markets[0].rewardApy = null;
    expect(codes(monitorPlan(input))).toContain("incentive-unavailable");
  });

  it("rejects invalid original inputs and marks demo baselines explicitly", () => {
    const input = inputs();
    input.original.intent.capitalUSDT = "NaN";
    expect(codes(monitorPlan(input))).toContain("invalid-original-plan");
    const demo = inputs();
    demo.original = planTreasury(defaultIntent, demoSnapshot, defaultCosts);
    expect(codes(monitorPlan(demo))).toContain("demo-baseline");
    demo.selectedPlanId = "unknown";
    expect(monitorPlan(demo).proposal).toBeNull();
  });

  it("is deterministic and never mutates saved assumptions, fresh data or wallet state", () => {
    const input = inputs();
    const before = structuredClone(input);
    const first = monitorPlan(input);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(monitorPlan(input)).toEqual(first);
    expect(input).toEqual(before);
    first.proposal!.intent.expenses[0].amountUSDT = "1";
    expect(input).toEqual(before);
    expect(() => monitorPlan({ ...input, now: Number.NaN })).toThrow();
  });
});

describe("wallet observation comparisons are not performance", () => {
  it("shows exact underlying value change with unchanged raw shares but never actual yield", () => {
    const previous = wallet(SAVED);
    const current = wallet(NOW);
    current.positions[0].underlyingAmount = "5500.123456";
    const result = compareWalletObservations(previous, current, NOW);
    expect(result.status).toBe("comparable");
    expect(result.positions[0].underlyingDelta).toBe("4.123456000000000000");
    expect(result.positions[0].sharesChanged).toBe(false);
    expect(result.actualNetYieldUSDT).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("marks changed shares and does not net distinct underlying assets", () => {
    const previous = wallet(SAVED);
    const current = wallet(NOW);
    current.positions[0].jTokenBalanceRaw = "123456000001";
    previous.positions.push({
      marketId: "justlend-usdd",
      underlyingAmount: "1",
      underlyingAsset: "USDD",
      jTokenBalanceRaw: "1",
      collateral: false,
    });
    current.positions.push({
      ...previous.positions[1],
      underlyingAmount: "1.000000000000000001",
    });
    const result = compareWalletObservations(previous, current, NOW);
    expect(result.positions[0].sharesChanged).toBe(true);
    expect(result.positions[1].underlyingDelta).toBe("0.000000000000000001");
    expect(result.actualNetYieldUSDT).toBeNull();
  });

  it("does not synthesize a missing position as zero", () => {
    const previous = wallet(SAVED);
    const current = wallet(NOW);
    current.positions = [];
    const result = compareWalletObservations(previous, current, NOW);
    expect(result.status).toBe("comparable");
    expect(result.positions[0].underlyingDelta).toBeNull();
    expect(result.positions[0].sharesChanged).toBeNull();
    expect(result.positions[0].currentRawShares).toBeNull();
  });

  it("rejects different owners, duplicate timestamps, reversed order, stale/future current snapshots and duplicate markets", () => {
    for (const variant of [
      "owner",
      "same-time",
      "reverse-time",
      "stale",
      "future",
      "duplicate",
    ] as const) {
      const previous = wallet(SAVED);
      const current = wallet(NOW);
      if (variant === "owner") current.address = "another-owner";
      if (variant === "same-time") previous.fetchedAt = NOW;
      if (variant === "reverse-time") previous.fetchedAt = shift(NOW, 1);
      if (variant === "stale") current.fetchedAt = shift(NOW, -300_001);
      if (variant === "future") current.fetchedAt = shift(NOW, 30_001);
      if (variant === "duplicate")
        previous.positions.push(structuredClone(previous.positions[0]));
      const result = compareWalletObservations(previous, current, NOW);
      expect(result.status).toBe("unavailable");
      expect(result.positions).toEqual([]);
      expect(result.actualNetYieldUSDT).toBeNull();
    }
  });
});
