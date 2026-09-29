import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  defaultCosts,
  defaultIntent,
  demoSnapshot,
} from "../src/domain/fixtures";
import { planTreasury } from "../src/domain/planner";
import { replayPlan } from "../src/domain/replay";

const plan = () =>
  planTreasury(structuredClone(defaultIntent), structuredClone(demoSnapshot), {
    ...defaultCosts,
  });

describe("saved-plan simulation", () => {
  it("retains the saved allocation, has explicit simulation provenance and applies adverse rates and costs", () => {
    const result = plan();
    const before = structuredClone(result);
    const replay = replayPlan(result, "yield");
    const original = result.plans.find((item) => item.id === "yield")!;
    expect(replay.kind).toBe("simulation");
    expect(replay.expectedNetUSDT).toBe(original.netYieldUSDT);
    expect(new Decimal(replay.grossYieldUSDT).lt(original.grossYieldUSDT)).toBe(
      true,
    );
    expect(
      new Decimal(replay.costUSDT).eq(
        new Decimal(original.costUSDT).mul("1.5"),
      ),
    ).toBe(true);
    expect(new Decimal(replay.deltaUSDT).lt(0)).toBe(true);
    expect(
      new Decimal(replay.grossYieldUSDT)
        .plus(replay.incentiveYieldUSDT)
        .minus(replay.costUSDT)
        .eq(replay.simulatedNetUSDT),
    ).toBe(true);
    expect(result).toEqual(before);
  });
  it("reproduces the original projection at unchanged rates and costs", () => {
    const result = plan();
    for (const original of result.plans) {
      const replay = replayPlan(result, original.id, {
        rateMultiplier: 1,
        costMultiplier: 1,
      });
      expect(replay.simulatedNetUSDT).toBe(original.netYieldUSDT);
      expect(replay.deltaUSDT).toBe("0.000000");
    }
  });
  it("leaves the cash baseline at zero and never invents a return", () => {
    const replay = replayPlan(plan(), "hold");
    expect(replay.grossYieldUSDT).toBe("0.000000");
    expect(replay.costUSDT).toBe("0.000000");
    expect(replay.simulatedNetUSDT).toBe("0.000000");
  });
  it("shows losses when yield goes to zero while costs remain", () => {
    const result = plan();
    const replay = replayPlan(result, "yield", {
      rateMultiplier: 0,
      costMultiplier: 1,
    });
    expect(replay.grossYieldUSDT).toBe("0.000000");
    expect(
      new Decimal(replay.simulatedNetUSDT).eq(
        new Decimal(replay.costUSDT).negated(),
      ),
    ).toBe(true);
    expect(new Decimal(replay.simulatedNetUSDT).lt(0)).toBe(true);
  });
  it("keeps incentive estimates separate and replays their explicit simple-rate assumption", () => {
    const result = planTreasury(defaultIntent, demoSnapshot, {
      ...defaultCosts,
      includeIncentives: true,
    });
    const original = result.plans.find((item) => item.id === "yield")!;
    const replay = replayPlan(result, "yield", {
      rateMultiplier: 1,
      costMultiplier: 1,
    });
    expect(replay.incentiveYieldUSDT).toBe(original.incentiveYieldUSDT);
    expect(new Decimal(replay.incentiveYieldUSDT).gt(0)).toBe(true);
    expect(replay.deltaUSDT).toBe("0.000000");
  });
  it("uses saved data rather than silently refreshing a stale snapshot", () => {
    const result = plan();
    result.snapshot.fetchedAt = "2000-01-01T00:00:00.000Z";
    expect(
      replayPlan(result, "yield", { rateMultiplier: 1, costMultiplier: 1 })
        .deltaUSDT,
    ).toBe("0.000000");
  });
  it("rejects absent source rates, invalid scenarios and unknown plans", () => {
    const result = plan();
    expect(() => replayPlan(result, "missing")).toThrow();
    for (const multiplier of [-1, 11, Number.NaN, Infinity]) {
      expect(() =>
        replayPlan(result, "yield", {
          rateMultiplier: multiplier,
          costMultiplier: 1,
        }),
      ).toThrow();
      expect(() =>
        replayPlan(result, "yield", {
          rateMultiplier: 1,
          costMultiplier: multiplier,
        }),
      ).toThrow();
    }
    result.snapshot.markets.forEach((market) => {
      market.baseApy = null;
    });
    expect(() => replayPlan(result, "yield")).toThrow();
  });
});
