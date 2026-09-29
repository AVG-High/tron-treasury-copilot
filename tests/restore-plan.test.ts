import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultCosts,
  defaultIntent,
  demoSnapshot,
} from "../src/domain/fixtures";
import { planTreasury } from "../src/domain/planner";
import { intentSchema } from "../src/domain/schema";
import { restorePlanConditions } from "../src/client/restore-plan";

const CREATED = "2026-09-20T12:00:00.000Z";
const NOW = "2026-09-28T12:00:00.000Z";
const shift = (date: string, ms: number) =>
  new Date(Date.parse(date) + ms).toISOString();
const stored = () => ({
  ...planTreasury(
    structuredClone(defaultIntent),
    structuredClone(demoSnapshot),
    { ...defaultCosts },
  ),
  selectedPlanId: "yield",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CREATED));
});
afterEach(() => vi.useRealTimers());

describe("saved condition restore preserves original deadlines", () => {
  it("preserves same-day conditions exactly and returns no confirmed or calculated plan", () => {
    const result = stored();
    const restored = restorePlanConditions(result, shift(CREATED, 60_000));
    expect(restored).toEqual({
      intent: result.intent,
      costs: result.costs,
      elapsedDays: 0,
      requiresNewHorizon: false,
    });
    expect(Object.keys(restored).sort()).toEqual([
      "costs",
      "elapsedDays",
      "intent",
      "requiresNewHorizon",
    ]);
  });

  it("advances deadlines from original calculation even if saving happened later", () => {
    const result = stored();
    const wrapper = { createdAt: NOW, plan: result };
    const restored = restorePlanConditions(wrapper.plan, NOW);
    expect(restored.elapsedDays).toBe(8);
    expect(restored.intent.horizonDays).toBe(22);
    expect(
      restored.intent.expenses.map((expense) => expense.dueInDays),
    ).toEqual([0, 22]);
    expect(
      restored.intent.expenses.map((expense) => expense.amountUSDT),
    ).toEqual(["3000", "1000"]);
    expect(restored.intent.capitalUSDT).toBe("10000");
    expect(restored.intent.emergencyUSDT).toBe("500");
    expect(restored.costs).toEqual(result.costs);
    expect(() => restorePlanConditions(wrapper, NOW)).toThrow();
  });

  it("keeps overdue expenses and requires a new explicit horizon after expiration", () => {
    for (const days of [30, 31, 5000]) {
      const restored = restorePlanConditions(
        stored(),
        shift(CREATED, days * 86_400_000),
      );
      expect(restored.requiresNewHorizon).toBe(true);
      expect(restored.intent.horizonDays).toBe(0);
      expect(
        restored.intent.expenses.map((expense) => expense.dueInDays),
      ).toEqual([0, 0]);
      expect(
        restored.intent.expenses.map((expense) => expense.amountUSDT),
      ).toEqual(["3000", "1000"]);
      expect(intentSchema.safeParse(restored.intent).success).toBe(false);
    }
  });

  it("counts whole UTC 24-hour intervals instead of date boundaries", () => {
    const result = stored();
    result.createdAt = "2026-09-20T23:59:00.000Z";
    expect(
      restorePlanConditions(result, "2026-09-21T00:01:00.000Z").elapsedDays,
    ).toBe(0);
    expect(
      restorePlanConditions(result, shift(result.createdAt, 86_400_000 - 1))
        .elapsedDays,
    ).toBe(0);
    expect(
      restorePlanConditions(result, shift(result.createdAt, 86_400_000))
        .elapsedDays,
    ).toBe(1);
    result.createdAt = "2026-09-20T05:00:00.000-07:00";
    expect(
      restorePlanConditions(result, "2026-09-21T12:00:00.000Z").elapsedDays,
    ).toBe(1);
  });

  it("tolerates only 30 seconds of future clock skew without negative elapsed days", () => {
    const result = stored();
    expect(
      restorePlanConditions(result, shift(CREATED, -30_000)).elapsedDays,
    ).toBe(0);
    expect(() =>
      restorePlanConditions(result, shift(CREATED, -30_001)),
    ).toThrow(/미래/);
  });

  it("rejects missing, ambiguous or malformed dates and invalid current clocks", () => {
    for (const date of [
      undefined,
      null,
      "",
      "2026-09-20",
      "2026-09-20T12:00:00",
      "2026-02-30T12:00:00Z",
      "invalid",
    ]) {
      expect(() =>
        restorePlanConditions({ ...stored(), createdAt: date }, NOW),
      ).toThrow();
    }
    for (const now of [
      Number.NaN,
      Infinity,
      8.64e15 + 1,
      "invalid",
      "2026-09-28T12:00:00",
    ]) {
      expect(() => restorePlanConditions(stored(), now)).toThrow();
    }
  });

  it("rejects unknown, infeasible, missing or ambiguous selected plans", () => {
    const result = stored();
    for (const bad of [
      null,
      {},
      { ...result, selectedPlanId: "missing" },
      { ...result, selectedPlanId: undefined },
      { ...result, feasible: false },
      { ...result, version: "unrecognized" },
      { ...result, plans: [] },
      { ...result, plans: [...result.plans, result.plans[0]] },
    ]) {
      expect(() => restorePlanConditions(bad, NOW)).toThrow();
    }
  });

  it("strictly validates original conditions and costs instead of filling missing values", () => {
    const result = stored();
    for (const intent of [
      { ...result.intent, horizonDays: 0 },
      { ...result.intent, capitalUSDT: "NaN" },
      { ...result.intent, allowLeverage: true },
      { ...result.intent, expenses: undefined },
      { ...result.intent, unexpected: true },
    ]) {
      expect(() => restorePlanConditions({ ...result, intent }, NOW)).toThrow();
    }
    for (const costs of [
      { ...result.costs, justlendUsdtRoundTripUSDT: null },
      { ...result.costs, source: "guessed" },
      { ...result.costs, justlendUsdtRoundTripUSDT: "-1" },
      { ...result.costs, unexpected: true },
    ]) {
      expect(() => restorePlanConditions({ ...result, costs }, NOW)).toThrow();
    }
  });

  it("never mutates records and produces independent editable copies", () => {
    const result = stored();
    const original = structuredClone(result);
    const restored = restorePlanConditions(result, NOW);
    restored.intent.expenses[0].amountUSDT = "1";
    restored.costs.justlendUsdtRoundTripUSDT = "99";
    expect(result).toEqual(original);
    expect(
      restorePlanConditions(result, NOW).intent.expenses[0].amountUSDT,
    ).toBe("3000");
  });

  it("uses the caller's explicit current time deterministically", () => {
    const result = stored();
    const first = restorePlanConditions(result, NOW);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(restorePlanConditions(result, NOW)).toEqual(first);
    expect(restorePlanConditions(result, Date.parse(NOW))).toEqual(first);
    expect(restorePlanConditions(result).requiresNewHorizon).toBe(true);
  });
});
