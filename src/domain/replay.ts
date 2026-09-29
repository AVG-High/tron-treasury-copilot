import Decimal from "decimal.js";
import type { PlanningResult } from "./types";

const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const down = (value: Decimal) => value.toDecimalPlaces(6, Decimal.ROUND_DOWN);
const up = (value: Decimal) => value.toDecimalPlaces(6, Decimal.ROUND_UP);

export interface ReplayOptions {
  rateMultiplier: number;
  costMultiplier: number;
}
export interface ReplayResult {
  kind: "simulation";
  expectedNetUSDT: string;
  simulatedNetUSDT: string;
  deltaUSDT: string;
  grossYieldUSDT: string;
  incentiveYieldUSDT: string;
  costUSDT: string;
}

/**
 * Replays the saved allocation and horizon under constant hypothetical rates and a cost multiplier.
 * It is neither an observed realized return nor a historical backtest. There is no reallocation,
 * wallet transaction, depeg model, or refreshed network data. Base APY compounds over the horizon;
 * opted-in incentives retain the planner's explicitly labelled simple-annualized approximation.
 */
export function replayPlan(
  result: PlanningResult,
  planId: string,
  options: ReplayOptions = { rateMultiplier: 0.5, costMultiplier: 1.5 },
): ReplayResult {
  if (
    !Number.isFinite(options.rateMultiplier) ||
    options.rateMultiplier < 0 ||
    options.rateMultiplier > 10 ||
    !Number.isFinite(options.costMultiplier) ||
    options.costMultiplier < 0 ||
    options.costMultiplier > 10
  ) {
    throw new Error("시뮬레이션 배수는 0 이상 10 이하의 숫자여야 합니다.");
  }
  const plan = result.plans.find((item) => item.id === planId);
  if (!result.feasible || !plan)
    throw new Error("시뮬레이션할 저장된 계획을 찾을 수 없습니다.");
  if (
    !Number.isInteger(result.intent.horizonDays) ||
    result.intent.horizonDays < 1 ||
    result.intent.horizonDays > 3650
  ) {
    throw new Error("저장된 계획의 운용 기간을 확인해 주세요.");
  }
  const horizon = new D(result.intent.horizonDays).div(365);
  let gross = new D(0);
  let incentive = new D(0);
  let cost = new D(0);
  for (const allocation of plan.allocations) {
    if (allocation.strategy === "wallet") continue;
    const matches = result.snapshot.markets.filter(
      (market) => market.id === allocation.strategy,
    );
    if (matches.length !== 1 || matches[0].baseApy === null) {
      throw new Error("저장된 시장 금리가 없어 시뮬레이션할 수 없습니다.");
    }
    const market = matches[0];
    const principal = new D(allocation.amountUSDT);
    const baseApy = new D(market.baseApy!).mul(options.rateMultiplier);
    if (
      !principal.isFinite() ||
      principal.lt(0) ||
      !baseApy.isFinite() ||
      baseApy.lt(0)
    ) {
      throw new Error("저장된 원금 또는 금리를 확인해 주세요.");
    }
    gross = gross.plus(
      down(principal.mul(baseApy.plus(1).pow(horizon).minus(1))),
    );
    if (result.costs.includeIncentives) {
      if (market.rewardApy === null)
        throw new Error(
          "저장된 보상률이 없어 보상 시뮬레이션을 할 수 없습니다.",
        );
      const rewardRate = new D(market.rewardApy).mul(options.rateMultiplier);
      if (!rewardRate.isFinite() || rewardRate.lt(0))
        throw new Error("저장된 보상률을 확인해 주세요.");
      incentive = incentive.plus(down(principal.mul(rewardRate).mul(horizon)));
    }
    const adjustedCost = new D(allocation.costUSDT).mul(options.costMultiplier);
    if (!adjustedCost.isFinite() || adjustedCost.lt(0))
      throw new Error("저장된 비용을 확인해 주세요.");
    cost = cost.plus(up(adjustedCost));
  }
  const net = gross.plus(incentive).minus(cost);
  return {
    kind: "simulation",
    expectedNetUSDT: plan.netYieldUSDT,
    simulatedNetUSDT: net.toFixed(6),
    deltaUSDT: net.minus(plan.netYieldUSDT).toFixed(6),
    grossYieldUSDT: gross.toFixed(6),
    incentiveYieldUSDT: incentive.toFixed(6),
    costUSDT: cost.toFixed(6),
  };
}
