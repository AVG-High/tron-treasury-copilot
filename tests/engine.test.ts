import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  defaultCosts,
  defaultIntent,
  demoSnapshot,
} from "../src/domain/fixtures";
import { planTreasury } from "../src/domain/planner";
import { costsSchema, intentSchema } from "../src/domain/schema";
import type {
  CostAssumptions,
  MarketSnapshot,
  PlanningResult,
  TreasuryIntent,
} from "../src/domain/types";

const copy = <T>(value: T): T => structuredClone(value);
const run = (
  intent: Partial<TreasuryIntent> = {},
  snapshot: MarketSnapshot = copy(demoSnapshot),
  costs: Partial<CostAssumptions> = {},
) =>
  planTreasury({ ...copy(defaultIntent), ...intent }, snapshot, {
    ...defaultCosts,
    ...costs,
  });
const investments = (result: PlanningResult) =>
  result.plans.filter((plan) => plan.id !== "hold");
function expectAccounting(result: PlanningResult) {
  for (const plan of result.plans) {
    const accounted = new Decimal(plan.reserveUSDT)
      .plus(plan.freeCashUSDT)
      .plus(plan.investedUSDT)
      .plus(plan.costUSDT);
    expect(
      accounted.eq(result.intent.capitalUSDT),
      `${plan.id} must conserve capital`,
    ).toBe(true);
    expect(new Decimal(plan.freeCashUSDT).gte(0)).toBe(true);
    expect(
      new Decimal(plan.grossYieldUSDT)
        .plus(plan.incentiveYieldUSDT)
        .minus(plan.costUSDT)
        .eq(plan.netYieldUSDT),
    ).toBe(true);
  }
}

describe("strict financial input validation", () => {
  it.each([
    "-1",
    "-0",
    "1e6",
    "1,000",
    "NaN",
    "Infinity",
    "0.0000001",
    "1000000000.000001",
    "01",
    "",
  ])("rejects invalid USDT input %s", (capitalUSDT) => {
    expect(
      intentSchema.safeParse({ ...defaultIntent, capitalUSDT }).success,
    ).toBe(false);
  });
  it("rejects fractional dates, unsupported leverage, duplicate obligations and unknown keys", () => {
    expect(
      intentSchema.safeParse({ ...defaultIntent, horizonDays: 1.5 }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({ ...defaultIntent, horizonDays: 0 }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({ ...defaultIntent, allowLeverage: true }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({
        ...defaultIntent,
        expenses: [defaultIntent.expenses[0], defaultIntent.expenses[0]],
      }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({ ...defaultIntent, privateKey: "unwanted" })
        .success,
    ).toBe(false);
    expect(
      costsSchema.safeParse({
        ...defaultCosts,
        justlendUsdtRoundTripUSDT: "-1",
      }).success,
    ).toBe(false);
  });
  it("returns validation errors instead of computing malformed inputs", () => {
    const result = run({ capitalUSDT: "1e6" });
    expect(result.feasible).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.plans).toHaveLength(0);
  });
});

describe("reserve-first allocation accounting", () => {
  it("reserves all expenses plus emergency and gives a hold baseline and two distinct positive-net scenarios", () => {
    const result = run();
    expect(result.reserveUSDT).toBe("4500.000000");
    expect(result.availableUSDT).toBe("5500.000000");
    expect(result.plans).toHaveLength(3);
    expect(result.plans[0].id).toBe("hold");
    expect(result.plans.every((plan) => !plan.executable)).toBe(true);
    expect(
      investments(result).every((plan) => new Decimal(plan.netYieldUSDT).gt(0)),
    ).toBe(true);
    expect(
      new Decimal(result.plans[2].freeCashUSDT).gt(
        result.plans[1].freeCashUSDT,
      ),
    ).toBe(true);
    expectAccounting(result);
  });
  it("earlier dates for already reserved payments do not manufacture rebalancing", () => {
    const before = run();
    const after = run({
      expenses: defaultIntent.expenses.map((expense) => ({
        ...expense,
        dueInDays: 1,
      })),
    });
    expect(after.plans).toEqual(before.plans);
  });
  it("adds a new obligation and reduces principal without spending the emergency reserve", () => {
    const before = run();
    const after = run({
      expenses: [
        ...defaultIntent.expenses,
        {
          id: "extra",
          label: "Additional bill",
          dueInDays: 1,
          amountUSDT: "3000",
        },
      ],
    });
    expect(after.reserveUSDT).toBe("7500.000000");
    expect(
      new Decimal(after.plans[1].investedUSDT).lt(before.plans[1].investedUSDT),
    ).toBe(true);
    expectAccounting(after);
  });
  it("reports infeasible obligations rather than a fake investment plan", () => {
    const result = run({ capitalUSDT: "4499.999999" });
    expect(result.feasible).toBe(false);
    expect(result.plans).toHaveLength(0);
    expect(result.errors[0]).toContain("0.000001");
  });
  it("retains a feasible all-cash plan when all capital is reserved", () => {
    const result = run({ capitalUSDT: "4500" });
    expect(result.feasible).toBe(true);
    expect(result.plans.map((plan) => plan.id)).toEqual(["hold"]);
    expectAccounting(result);
  });
  it("conserves fractional balances exactly without floating-point overspend", () => {
    const result = run(
      { capitalUSDT: "10000.123456", emergencyUSDT: "500.654321" },
      copy(demoSnapshot),
      {
        justlendUsdtRoundTripUSDT: "4.123456",
        justlendUsddRoundTripUSDT: "8.345678",
      },
    );
    expectAccounting(result);
  });
});

describe("cost-aware projections", () => {
  it("prefers holding when 7-day 6% APY yield on 2000 cannot cover a 4-USDT round trip", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.markets[0].baseApy = "0.06";
    const result = run(
      {
        capitalUSDT: "2000",
        emergencyUSDT: "0",
        expenses: [],
        horizonDays: 7,
        maxUSDDExposurePct: 0,
        maxProtocolExposurePct: 100,
      },
      snapshot,
    );
    expect(result.plans.map((plan) => plan.id)).toEqual(["hold"]);
    expect(
      result.exclusions.some(
        (item) => item.code === "no-positive-net-candidate",
      ),
    ).toBe(true);
  });
  it("uses the APY period factor, keeps rewards separate, and funds costs outside principal", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.markets[0].baseApy = "0.06";
    snapshot.markets[0].rewardApy = "0.12";
    const result = run(
      {
        capitalUSDT: "2000",
        emergencyUSDT: "0",
        expenses: [],
        horizonDays: 30,
        maxUSDDExposurePct: 0,
        maxProtocolExposurePct: 100,
      },
      snapshot,
    );
    const plan = result.plans[1];
    expect(plan.investedUSDT).toBe("1996.000000");
    expect(plan.costUSDT).toBe("4.000000");
    expect(plan.incentiveYieldUSDT).toBe("0.000000");
    const expectedGross = new Decimal("1996")
      .mul(new Decimal("1.06").pow(new Decimal(30).div(365)).minus(1))
      .toDecimalPlaces(6, Decimal.ROUND_DOWN);
    expect(plan.grossYieldUSDT).toBe(expectedGross.toFixed(6));
    expect(plan.breakevenDays).toBeGreaterThan(12);
    expect(plan.breakevenDays).toBeLessThan(13);
    expectAccounting(result);
  });
  it("charges each activated strategy once, with no fees charged to cash", () => {
    const result = run();
    for (const plan of investments(result)) {
      const expected = plan.allocations.reduce(
        (sum, row) =>
          sum.plus(
            row.strategy === "justlend-usdt"
              ? defaultCosts.justlendUsdtRoundTripUSDT
              : defaultCosts.justlendUsddRoundTripUSDT,
          ),
        new Decimal(0),
      );
      expect(new Decimal(plan.costUSDT).eq(expected)).toBe(true);
      expect(new Set(plan.allocations.map((row) => row.strategy)).size).toBe(
        plan.allocations.length,
      );
    }
    expect(result.plans[0].costUSDT).toBe("0.000000");
  });
  it("does not invent positive profit or break-even at zero yield", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.markets.forEach((market) => {
      market.baseApy = "0";
      market.rewardApy = "0";
    });
    const result = run({}, snapshot);
    expect(result.plans.map((plan) => plan.id)).toEqual(["hold"]);
    expect(result.plans[0].breakevenDays).toBeNull();
  });
  it("reports zero break-even for an explicitly zero-cost positive-yield assumption", () => {
    const result = run({ maxUSDDExposurePct: 0 }, copy(demoSnapshot), {
      justlendUsdtRoundTripUSDT: "0",
    });
    expect(result.plans[1].breakevenDays).toBe(0);
    expectAccounting(result);
  });
  it("counts incentives only by opt-in and never treats unavailable incentives as zero", () => {
    const optedIn = run({}, copy(demoSnapshot), { includeIncentives: true });
    expect(new Decimal(optedIn.plans[1].incentiveYieldUSDT).gt(0)).toBe(true);
    const snapshot = copy(demoSnapshot);
    snapshot.markets.forEach((market) => {
      market.rewardApy = null;
    });
    const missing = run({}, snapshot, { includeIncentives: true });
    expect(missing.plans.map((plan) => plan.id)).toEqual(["hold"]);
    expect(
      missing.exclusions.every((row) => row.code === "missing-incentive-rate"),
    ).toBe(true);
  });
});

describe("asset, protocol and exit constraints", () => {
  it("aggregates the protocol cap across both JustLend markets", () => {
    const result = run({
      expenses: [],
      emergencyUSDT: "0",
      maxProtocolExposurePct: 25,
      maxUSDDExposurePct: 10,
    });
    for (const plan of investments(result)) {
      expect(new Decimal(plan.investedUSDT).lte(2500)).toBe(true);
      const usdd = plan.allocations.find(
        (row) => row.strategy === "justlend-usdd",
      );
      if (usdd) expect(new Decimal(usdd.amountUSDT).lte(1000)).toBe(true);
    }
    expectAccounting(result);
  });
  it("excludes USDD when its exposure cap is zero", () => {
    const result = run({ maxUSDDExposurePct: 0 });
    expect(
      investments(result).every((plan) =>
        plan.allocations.every((row) => row.strategy === "justlend-usdt"),
      ),
    ).toBe(true);
    expect(
      result.exclusions.some((row) => row.code === "usdd-exposure-disallowed"),
    ).toBe(true);
  });
  it("limits principal plus projected base yield to market cash and PSM exit capacity", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.markets[0].cashUSDT = "600";
    snapshot.psm.availableUSDT = "800";
    const result = run({}, snapshot);
    for (const plan of investments(result))
      for (const row of plan.allocations) {
        const estimatedExit = new Decimal(row.amountUSDT).plus(
          row.grossYieldUSDT,
        );
        expect(
          estimatedExit.lte(row.strategy === "justlend-usdt" ? "600" : "800"),
        ).toBe(true);
      }
    expectAccounting(result);
  });
  it("requires a complete PSM round trip and known fee data", () => {
    for (const property of [
      "toUSDDEnabled",
      "fromUSDDEnabled",
      "available",
    ] as const) {
      const snapshot = copy(demoSnapshot);
      snapshot.psm[property] = false;
      expect(
        run({}, snapshot).exclusions.some(
          (row) => row.code === "psm-roundtrip-unavailable",
        ),
      ).toBe(true);
    }
    const snapshot = copy(demoSnapshot);
    snapshot.psm.fromUSDDFeePct = null;
    expect(
      run({}, snapshot).exclusions.some(
        (row) => row.code === "psm-roundtrip-unavailable",
      ),
    ).toBe(true);
  });
  it("reserves proportional PSM fees without exceeding cash even at micro precision", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.psm.toUSDDFeePct = "0.000001";
    snapshot.psm.fromUSDDFeePct = "0.000001";
    snapshot.markets[1].baseApy = "0.2";
    const result = run({ capitalUSDT: "10000.123456" }, snapshot);
    expectAccounting(result);
    const usddRows = investments(result)
      .flatMap((plan) => plan.allocations)
      .filter((row) => row.strategy === "justlend-usdd");
    expect(usddRows.length).toBeGreaterThan(0);
    expect(
      usddRows.every((row) =>
        new Decimal(row.costUSDT).gt(defaultCosts.justlendUsddRoundTripUSDT),
      ),
    ).toBe(true);
  });
});

describe("evidence and execution boundaries", () => {
  function live(): MarketSnapshot {
    const snapshot = copy(demoSnapshot);
    snapshot.mode = "live";
    snapshot.fetchedAt = new Date().toISOString();
    snapshot.markets.forEach((market) => {
      market.quality = "verified";
      market.evidence.forEach((row) => {
        row.fetchedAt = snapshot.fetchedAt;
      });
    });
    snapshot.psm.evidence.forEach((row) => {
      row.fetchedAt = snapshot.fetchedAt;
    });
    return snapshot;
  }
  it("does not promote fixtures to live executable plans", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.mode = "live";
    const result = run({}, snapshot, { source: "wallet-estimate" });
    expect(result.plans.map((plan) => plan.id)).toEqual(["hold"]);
  });
  it("rejects stale snapshot and stale underlying evidence", () => {
    const staleDate = new Date(Date.now() - 6 * 60_000).toISOString();
    const snapshot = live();
    snapshot.fetchedAt = staleDate;
    expect(run({}, snapshot).plans.map((plan) => plan.id)).toEqual(["hold"]);
    const staleMarket = live();
    staleMarket.markets[0].evidence[0].fetchedAt = staleDate;
    expect(
      run({}, staleMarket).exclusions.some(
        (row) =>
          row.strategy === "justlend-usdt" && row.code === "stale-evidence",
      ),
    ).toBe(true);
    const stalePsm = live();
    stalePsm.psm.evidence[0].fetchedAt = staleDate;
    expect(
      run({}, stalePsm).exclusions.some((row) => row.code === "stale-psm"),
    ).toBe(true);
  });
  it("does not treat missing liquidity as zero or infer it from a different market", () => {
    const snapshot = live();
    snapshot.markets[0].cashUSDT = null;
    expect(
      run({}, snapshot).exclusions.some(
        (row) => row.code === "missing-rate-or-cash",
      ),
    ).toBe(true);
  });
  it("rejects duplicate market records rather than allocating twice and charging two fees", () => {
    const snapshot = copy(demoSnapshot);
    snapshot.markets.push(copy(snapshot.markets[0]));
    expect(
      run({}, snapshot).exclusions.some(
        (row) => row.code === "duplicate-market",
      ),
    ).toBe(true);
  });
  it("requires live verified data and wallet estimates even for USDT execution eligibility", () => {
    expect(
      run({ maxUSDDExposurePct: 0 }, live()).plans.every(
        (plan) => !plan.executable,
      ),
    ).toBe(true);
    const eligible = run({ maxUSDDExposurePct: 0 }, live(), {
      source: "wallet-estimate",
    });
    expect(investments(eligible).every((plan) => plan.executable)).toBe(true);
  });
});
