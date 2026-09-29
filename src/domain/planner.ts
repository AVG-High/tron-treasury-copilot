import Decimal from "decimal.js";
import { costsSchema, intentSchema } from "./schema";
import type {
  Allocation,
  CostAssumptions,
  Market,
  MarketSnapshot,
  Plan,
  PlanningResult,
  TreasuryIntent,
} from "./types";

const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new D(0);
const SCALE = 6;
const STALE_MS = 5 * 60 * 1000;
export const PLANNER_VERSION = "treasury-reserve-first-v1";
const down = (value: Decimal) =>
  value.toDecimalPlaces(SCALE, Decimal.ROUND_DOWN);
const up = (value: Decimal) => value.toDecimalPlaces(SCALE, Decimal.ROUND_UP);
const money = (value: Decimal) => value.toFixed(SCALE);
const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), ZERO);
const number = (
  value: string | null,
  max = "1000000000000000",
): Decimal | null => {
  if (value === null || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
  try {
    const parsed = new D(value);
    return parsed.isFinite() && parsed.lte(max) ? parsed : null;
  } catch {
    return null;
  }
};
const fresh = (date: string, now: number) => {
  const timestamp = Date.parse(date);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 30_000 &&
    now - timestamp <= STALE_MS
  );
};
const inputIssue = (issue: { path: PropertyKey[]; message: string }) => {
  const labels: Record<string, string> = {
    capitalUSDT: "총자금",
    horizonDays: "운용 기간",
    emergencyUSDT: "비상금",
    expenses: "예정 지출",
    maxUSDDExposurePct: "USDD 노출 한도",
    maxProtocolExposurePct: "프로토콜 노출 한도",
    allowVolatile: "변동성 자산 허용",
    allowLeverage: "레버리지 허용",
    justlendUsdtRoundTripUSDT: "USDT 왕복 비용",
    justlendUsddRoundTripUSDT: "USDD 왕복 비용",
    source: "비용 출처",
    includeIncentives: "보상 포함 여부",
  };
  const label = labels[String(issue.path[0])] ?? "입력값";
  return `${label}: ${/[가-힣]/.test(issue.message) ? issue.message : "형식과 허용 범위를 확인해 주세요."}`;
};

interface CandidateMarket {
  market: Market;
  rate: Decimal;
  reward: Decimal | null;
  factor: Decimal;
  rewardFactor: Decimal;
  maxPrincipal: Decimal;
  fixedCost: Decimal;
  feeFraction: Decimal;
}

/**
 * Reserve-first accounting (all quantities are USDT scenario values):
 * capital = dated expense reserve + emergency reserve + free cash + principal + round-trip cost reserve.
 * A round-trip cost is reserved exactly once per active strategy. Projected gross yield is not
 * spendable principal and cannot fund transaction fees. Exit-side reserves remain idle until used.
 * The engine compares a bounded set of transparent allocations, not a global optimizer.
 */
export function planTreasury(
  intent: TreasuryIntent,
  snapshot: MarketSnapshot,
  costs: CostAssumptions,
): PlanningResult {
  const now = Date.now();
  const result: PlanningResult = {
    version: PLANNER_VERSION,
    createdAt: new Date(now).toISOString(),
    intent,
    snapshot,
    costs,
    reserveUSDT: "0.000000",
    availableUSDT: "0.000000",
    feasible: false,
    errors: [],
    plans: [],
    exclusions: [],
  };
  const parsedIntent = intentSchema.safeParse(intent);
  const parsedCosts = costsSchema.safeParse(costs);
  if (!parsedIntent.success || !parsedCosts.success) {
    result.errors = [
      ...(!parsedIntent.success
        ? parsedIntent.error.issues.map(inputIssue)
        : []),
      ...(!parsedCosts.success ? parsedCosts.error.issues.map(inputIssue) : []),
    ];
    return result;
  }
  const capital = new D(intent.capitalUSDT);
  const reserve = sum(
    intent.expenses.map((expense) => new D(expense.amountUSDT)),
  ).plus(intent.emergencyUSDT);
  const available = capital.minus(reserve);
  result.reserveUSDT = money(reserve);
  result.availableUSDT = money(D.max(ZERO, available));
  if (available.isNegative()) {
    result.errors = [
      `예정 지출과 비상금이 총자금보다 ${money(available.negated())} USDT 많습니다. 투자 전에 지출을 줄이거나 자금을 보충해 주세요.`,
    ];
    return result;
  }
  result.feasible = true;
  const generalWarnings = [
    "현재 금리가 유지된다는 가정입니다. 수익을 보장하지 않으며 스테이블코인과 프로토콜에도 손실 위험이 있습니다.",
    "예정 지출은 전액 확보합니다. 남은 자금의 운용 기간은 지출일과 별도로 적용합니다.",
    "현재 시장 유동성과 PSM 잔액은 미래 출금을 보장하지 않습니다.",
    "가용 예산의 25·50·75·100% 사용과 상품 간 0·25·50·75·100% 배분을 한도 내에서 비교합니다. 모든 배분의 최적해를 뜻하지 않습니다.",
    ...(snapshot.mode === "demo"
      ? ["데모 데이터로 만든 계획은 실행할 수 없습니다."]
      : []),
    ...(costs.source === "user-assumption"
      ? ["비용은 사용자 가정값입니다. 지갑별 실제 실행 견적이 아닙니다."]
      : []),
    ...(costs.includeIncentives
      ? [
          "보상은 연환산 보상률을 기간에 따라 단리 환산한 참고치입니다. 자동 복리를 가정하지 않으며 토큰 가격·종료일·수령·매도 비용을 별도 확인해야 합니다.",
        ]
      : []),
    ...snapshot.warnings,
  ];
  result.plans.push({
    id: "hold",
    name: "현금 보유",
    objective: "DeFi 거래 없이 지출 대응 자금을 유지합니다.",
    allocations: [
      {
        strategy: "wallet",
        amountUSDT: money(capital),
        grossYieldUSDT: "0.000000",
        incentiveYieldUSDT: "0.000000",
        costUSDT: "0.000000",
        netYieldUSDT: "0.000000",
        reasons: [
          "추가 거래가 필요하지 않습니다.",
          "지갑의 USDT에도 발행사 위험과 페그 이탈 위험이 있습니다.",
        ],
      },
    ],
    reserveUSDT: money(reserve),
    freeCashUSDT: money(available),
    investedUSDT: "0.000000",
    grossYieldUSDT: "0.000000",
    incentiveYieldUSDT: "0.000000",
    costUSDT: "0.000000",
    netYieldUSDT: "0.000000",
    breakevenDays: null,
    executable: false,
    warnings: [...generalWarnings],
  });
  const exclude = (strategy: string, code: string, reason: string) =>
    result.exclusions.push({ strategy, code, reason });
  const horizon = new D(intent.horizonDays).div(365);
  const protocolCap = down(capital.mul(intent.maxProtocolExposurePct).div(100));
  const usddCap = down(capital.mul(intent.maxUSDDExposurePct).div(100));
  const candidates: CandidateMarket[] = [];
  const liveSnapshotFresh =
    snapshot.mode === "demo" || fresh(snapshot.fetchedAt, now);
  for (const id of ["justlend-usdt", "justlend-usdd"] as const) {
    const matches = snapshot.markets.filter((market) => market.id === id);
    if (matches.length !== 1) {
      exclude(
        id,
        matches.length ? "duplicate-market" : "missing-market",
        "완전한 시장 데이터가 하나 필요합니다. 누락되거나 중복된 데이터는 사용하지 않습니다.",
      );
      continue;
    }
    const market = matches[0];
    const isUsdd = id === "justlend-usdd";
    if (market.asset !== (isUsdd ? "USDD" : "USDT")) {
      exclude(
        id,
        "asset-mismatch",
        "전략의 자산과 시장의 자산이 일치하지 않습니다.",
      );
      continue;
    }
    if (!market.active) {
      exclude(
        id,
        "inactive-market",
        "이 시장은 신규 예치가 활성화되지 않았습니다.",
      );
      continue;
    }
    if (
      !liveSnapshotFresh ||
      market.quality === "stale" ||
      market.quality === "unavailable" ||
      (snapshot.mode === "live" && market.quality !== "verified")
    ) {
      exclude(
        id,
        "unverified-data",
        "실시간 시장에는 5분 이내에 확인한 데이터가 필요합니다. 누락값을 데모로 대신하지 않습니다.",
      );
      continue;
    }
    if (
      snapshot.mode === "live" &&
      (!market.evidence.length ||
        market.evidence.some((evidence) => !fresh(evidence.fetchedAt, now)))
    ) {
      exclude(id, "stale-evidence", "최신 시장 출처를 확인해야 합니다.");
      continue;
    }
    const rate = number(market.baseApy, "1000000");
    const reward = number(market.rewardApy, "1000000");
    const cash = number(market.cashUSDT);
    if (rate === null || cash === null) {
      exclude(
        id,
        "missing-rate-or-cash",
        "기본 APY와 출금 가능 유동성이 모두 확인되어야 합니다.",
      );
      continue;
    }
    if (costs.includeIncentives && reward === null) {
      exclude(
        id,
        "missing-incentive-rate",
        "선택한 보상률을 확인하지 못했습니다. 누락된 보상을 0으로 처리하지 않습니다.",
      );
      continue;
    }
    const factor = new D(1).plus(rate).pow(horizon).minus(1);
    const rewardFactor =
      costs.includeIncentives && reward !== null ? reward.mul(horizon) : ZERO;
    // Conservatively limit principal + projected base interest to the currently observed exit cash.
    let maxPrincipal = D.min(protocolCap, cash.div(factor.plus(1)));
    let feeFraction = ZERO;
    if (isUsdd) {
      if (usddCap.isZero()) {
        exclude(
          id,
          "usdd-exposure-disallowed",
          "USDD 노출을 허용하지 않은 조건입니다.",
        );
        continue;
      }
      const psm = snapshot.psm;
      const entryFeePct = number(psm.toUSDDFeePct, "99.999999");
      const exitFeePct = number(psm.fromUSDDFeePct, "99.999999");
      const psmCash = number(psm.availableUSDT);
      if (
        !psm.available ||
        !psm.toUSDDEnabled ||
        !psm.fromUSDDEnabled ||
        entryFeePct === null ||
        exitFeePct === null ||
        psmCash === null
      ) {
        exclude(
          id,
          "psm-roundtrip-unavailable",
          "PSM 왕복 전환, 수수료와 현재 USDT 회수 가능액이 모두 확인되어야 합니다.",
        );
        continue;
      }
      if (
        snapshot.mode === "live" &&
        (!psm.evidence.length ||
          psm.evidence.some((evidence) => !fresh(evidence.fetchedAt, now)))
      ) {
        exclude(
          id,
          "stale-psm",
          "실시간 왕복 경로에는 최신 PSM 상태가 필요합니다.",
        );
        continue;
      }
      const entry = entryFeePct.div(100);
      const exit = exitFeePct.div(100);
      // Principal is the supplied USDD amount at the explicit 1:1 scenario. Entry top-up and
      // exit fee (including projected base interest) are reserved in addition to that principal.
      feeFraction = entry
        .div(new D(1).minus(entry))
        .plus(exit.mul(factor.plus(1)));
      maxPrincipal = D.min(maxPrincipal, usddCap, psmCash.div(factor.plus(1)));
    }
    if (maxPrincipal.lte(0)) {
      exclude(
        id,
        "zero-capacity",
        "노출 한도 또는 현재 출금 유동성 때문에 배분 가능한 금액이 없습니다.",
      );
      continue;
    }
    if (factor.plus(rewardFactor).isZero()) {
      exclude(
        id,
        "zero-yield",
        "현재 수익률로는 현금 보유보다 추가 수익을 기대할 수 없습니다.",
      );
      continue;
    }
    candidates.push({
      market,
      rate,
      reward,
      factor,
      rewardFactor,
      maxPrincipal: down(maxPrincipal),
      fixedCost: new D(
        isUsdd
          ? costs.justlendUsddRoundTripUSDT
          : costs.justlendUsdtRoundTripUSDT,
      ),
      feeFraction,
    });
  }

  const allocations = new Map<string, Plan>();
  const build = (shares: number[], utilization: number): void => {
    const active = candidates
      .map((candidate, index) => ({ candidate, share: new D(shares[index]) }))
      .filter((row) => row.share.gt(0));
    if (!active.length) return;
    const fixed = sum(active.map((row) => row.candidate.fixedCost));
    // Leave one micro-USDT per proportional fee for conservative upward rounding.
    const roundingBuffer = new D(
      active.filter((row) => row.candidate.feeFraction.gt(0)).length,
    ).mul("0.000001");
    const spend = available.mul(utilization).minus(fixed).minus(roundingBuffer);
    if (spend.lte(0)) return;
    const weightedFee = sum(
      active.map((row) => row.candidate.feeFraction.mul(row.share)),
    );
    let principal = D.min(spend.div(weightedFee.plus(1)), protocolCap);
    for (const row of active)
      principal = D.min(principal, row.candidate.maxPrincipal.div(row.share));
    const rows: Allocation[] = active.map(({ candidate, share }) => {
      const amount = down(principal.mul(share));
      const gross = down(amount.mul(candidate.factor));
      const incentive = down(amount.mul(candidate.rewardFactor));
      const cost = up(
        candidate.fixedCost.plus(amount.mul(candidate.feeFraction)),
      );
      return {
        strategy: candidate.market.id,
        amountUSDT: money(amount),
        grossYieldUSDT: money(gross),
        incentiveYieldUSDT: money(incentive),
        costUSDT: money(cost),
        netYieldUSDT: money(gross.plus(incentive).minus(cost)),
        reasons: [
          `남은 자금의 운용 기간 ${intent.horizonDays}일, 기본 APY ${candidate.rate.mul(100).toString()}% 유지 가정입니다.`,
          "원금과 추정 기본 이자의 합계가 현재 확인한 출금 유동성 이내입니다.",
          ...(candidate.market.asset === "USDD"
            ? [
                "USDD와 USDT의 1:1 가치를 가정하며 페그를 보장하지 않습니다.",
                "PSM 왕복 비용을 반영하며 다른 JustLend 시장과 프로토콜 노출 한도를 공유합니다.",
              ]
            : ["USDT를 예치하므로 다른 스테이블코인으로 전환하지 않습니다."]),
          ...candidate.market.warnings,
        ],
      };
    });
    if (
      rows.some(
        (row) => new D(row.amountUSDT).lte(0) || new D(row.netYieldUSDT).lte(0),
      )
    )
      return;
    const invested = sum(rows.map((row) => new D(row.amountUSDT)));
    const cost = sum(rows.map((row) => new D(row.costUSDT)));
    const free = available.minus(invested).minus(cost);
    // Upward fee rounding can exceed the budget by a micro-USDT; never display an overdrawn plan.
    if (free.isNegative() || invested.gt(protocolCap)) return;
    const gross = sum(rows.map((row) => new D(row.grossYieldUSDT)));
    const incentive = sum(rows.map((row) => new D(row.incentiveYieldUSDT)));
    const net = gross.plus(incentive).minus(cost);
    if (net.lte(0)) return;
    const key = rows
      .map((row) => `${row.strategy}:${row.amountUSDT}`)
      .join("|");
    allocations.set(key, {
      id: `candidate-${allocations.size + 1}`,
      name: "수익 시나리오",
      objective: "왕복 비용을 확보한 뒤 순수익을 비교합니다.",
      allocations: rows,
      reserveUSDT: money(reserve),
      freeCashUSDT: money(free),
      investedUSDT: money(invested),
      grossYieldUSDT: money(gross),
      incentiveYieldUSDT: money(incentive),
      costUSDT: money(cost),
      netYieldUSDT: money(net),
      breakevenDays: null,
      // A plan flag never authorizes execution; wallet/quote/borrow checks are still required.
      executable:
        snapshot.mode === "live" &&
        costs.source === "wallet-estimate" &&
        rows.every((row) => row.strategy === "justlend-usdt"),
      warnings: [
        ...generalWarnings,
        ...(rows.some((row) => row.strategy === "justlend-usdd")
          ? [
              "USDD 경로는 비교용입니다. 이 버전에서는 USDD 거래를 실행하지 않습니다.",
              ...snapshot.psm.warnings,
            ]
          : []),
      ],
    });
  };
  const withBreakeven = (plan: Plan): Plan => {
    const breakeven = (days: number) =>
      sum(
        plan.allocations.map((row) => {
          const candidate = candidates.find(
            (item) => item.market.id === row.strategy,
          )!;
          const yearFraction = new D(days).div(365);
          const amount = new D(row.amountUSDT);
          const base = amount.mul(
            candidate.rate.plus(1).pow(yearFraction).minus(1),
          );
          const rewardYield =
            costs.includeIncentives && candidate.reward !== null
              ? amount.mul(candidate.reward).mul(yearFraction)
              : ZERO;
          // Include varying exit fee on interest rather than pretending it is constant at another horizon.
          const exitFee =
            candidate.market.asset === "USDD"
              ? new D(snapshot.psm.fromUSDDFeePct!).div(100)
              : ZERO;
          const initialCost = new D(row.costUSDT).minus(
            new D(row.grossYieldUSDT).mul(exitFee),
          );
          return base
            .mul(new D(1).minus(exitFee))
            .plus(rewardYield)
            .minus(initialCost);
        }),
      ).gte(0);
    if (breakeven(0)) return { ...plan, breakevenDays: 0 };
    let lo = 0,
      hi = intent.horizonDays;
    for (let iteration = 0; iteration < 45; iteration++) {
      const mid = (lo + hi) / 2;
      if (breakeven(mid)) hi = mid;
      else lo = mid;
    }
    return { ...plan, breakevenDays: Math.ceil(hi * 100) / 100 };
  };
  const mixes =
    candidates.length === 2
      ? [
          [1, 0],
          [0, 1],
          [0.75, 0.25],
          [0.5, 0.5],
          [0.25, 0.75],
        ]
      : candidates.length === 1
        ? [[1]]
        : [];
  for (const mix of mixes)
    for (const utilization of [1, 0.75, 0.5, 0.25]) build(mix, utilization);
  const ordered = [...allocations.values()].sort(
    (a, b) =>
      new D(b.netYieldUSDT).cmp(a.netYieldUSDT) ||
      new D(a.investedUSDT).cmp(b.investedUSDT),
  );
  if (ordered.length) {
    const best = ordered[0];
    result.plans.push(
      withBreakeven({
        ...best,
        id: "yield",
        name: "순수익 우선",
        objective: "비교한 배분 후보 중 추정 순수익이 가장 높은 안입니다.",
      }),
    );
    const halfPrincipal = new D(best.investedUSDT).div(2);
    const liquidAlternatives = ordered
      .slice(1)
      .filter((plan) => new D(plan.investedUSDT).lte(halfPrincipal));
    const alternative =
      liquidAlternatives[0] ??
      ordered
        .slice(1)
        .find((plan) => new D(plan.freeCashUSDT).gt(best.freeCashUSDT));
    if (alternative)
      result.plans.push(
        withBreakeven({
          ...alternative,
          id: "liquidity",
          name: "유동성 우선",
          objective:
            "추정 순수익을 유지하면서 자유롭게 쓸 수 있는 현금을 더 남깁니다.",
        }),
      );
  }
  for (const candidate of candidates) {
    if (
      !ordered.some((plan) =>
        plan.allocations.some(
          (allocation) => allocation.strategy === candidate.market.id,
        ),
      )
    ) {
      exclude(
        candidate.market.id,
        "no-positive-net-candidate",
        "왕복 비용과 제약을 반영하면 비교한 배분 중 현금 보유보다 순수익이 높은 안이 없습니다.",
      );
    }
  }
  return result;
}
