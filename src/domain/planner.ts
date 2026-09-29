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
    capitalUSDT: "Total capital",
    horizonDays: "Investment horizon",
    emergencyUSDT: "Emergency reserve",
    expenses: "Scheduled expenses",
    maxUSDDExposurePct: "USDD exposure limit",
    maxProtocolExposurePct: "Protocol exposure limit",
    allowVolatile: "Allow volatile assets",
    allowLeverage: "Allow leverage",
    justlendUsdtRoundTripUSDT: "USDT round-trip cost",
    justlendUsddRoundTripUSDT: "USDD round-trip cost",
    source: "Cost source",
    includeIncentives: "Include incentives",
  };
  const label = labels[String(issue.path[0])] ?? "Input";
  return `${label}: ${/[가-힣]/.test(issue.message) ? issue.message : "Check the format and allowed range."}`;
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
      `Scheduled expenses and emergency reserves exceed total capital by ${money(available.negated())} USDT. Reduce expenses or add funds before investing.`,
    ];
    return result;
  }
  result.feasible = true;
  const generalWarnings = [
    "Assumes rates stay unchanged. Returns are not guaranteed; stablecoins and protocols carry loss risk.",
    "All scheduled expenses are reserved. The investment horizon applies separately to the remaining funds.",
    "Current market liquidity and PSM balances do not guarantee future withdrawals.",
    "Compares 25/50/75/100% budget usage and 0/25/50/75/100% product splits within your limits. This is not a global optimization of all possible allocations.",
    ...(snapshot.mode === "demo"
      ? ["Plans based on demo data cannot be executed."]
      : []),
    ...(costs.source === "user-assumption"
      ? ["Costs are user assumptions, not wallet-specific execution quotes."]
      : []),
    ...(costs.includeIncentives
      ? [
          "Incentives use a simple annualized estimate, without automatic compounding. Check token prices, end dates, and claim and sale costs separately.",
        ]
      : []),
    ...snapshot.warnings,
  ];
  result.plans.push({
    id: "hold",
    name: "Hold USDT",
    objective: "Keep funds available for expenses without DeFi transactions.",
    allocations: [
      {
        strategy: "wallet",
        amountUSDT: money(capital),
        grossYieldUSDT: "0.000000",
        incentiveYieldUSDT: "0.000000",
        costUSDT: "0.000000",
        netYieldUSDT: "0.000000",
        reasons: [
          "No additional transactions required.",
          "USDT held in a wallet still carries issuer and depegging risk.",
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
        "Exactly one complete market record is required. Missing or duplicate data is not used.",
      );
      continue;
    }
    const market = matches[0];
    const isUsdd = id === "justlend-usdd";
    if (market.asset !== (isUsdd ? "USDD" : "USDT")) {
      exclude(
        id,
        "asset-mismatch",
        "The strategy asset does not match the market asset.",
      );
      continue;
    }
    if (!market.active) {
      exclude(
        id,
        "inactive-market",
        "New deposits are disabled for this market.",
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
        "Live markets require data checked within 5 minutes. Missing values are not replaced with demo data.",
      );
      continue;
    }
    if (
      snapshot.mode === "live" &&
      (!market.evidence.length ||
        market.evidence.some((evidence) => !fresh(evidence.fetchedAt, now)))
    ) {
      exclude(
        id,
        "stale-evidence",
        "Fresh market source evidence is required.",
      );
      continue;
    }
    const rate = number(market.baseApy, "1000000");
    const reward = number(market.rewardApy, "1000000");
    const cash = number(market.cashUSDT);
    if (rate === null || cash === null) {
      exclude(
        id,
        "missing-rate-or-cash",
        "Both base APY and withdrawal liquidity must be verified.",
      );
      continue;
    }
    if (costs.includeIncentives && reward === null) {
      exclude(
        id,
        "missing-incentive-rate",
        "The selected incentive rate is unverified. Missing incentives are not treated as zero.",
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
          "Your conditions do not allow USDD exposure.",
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
          "Both PSM directions, fees, and currently redeemable USDT must be verified.",
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
          "A live round-trip route requires fresh PSM status.",
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
        "Exposure limits or current withdrawal liquidity leave no allocatable amount.",
      );
      continue;
    }
    if (factor.plus(rewardFactor).isZero()) {
      exclude(
        id,
        "zero-yield",
        "Current rates offer no expected additional return over holding cash.",
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
          `Assumes an investment horizon of ${intent.horizonDays} days and an unchanged base APY of ${candidate.rate.mul(100).toString()}%.`,
          "Principal plus estimated base interest fits within current verified withdrawal liquidity.",
          ...(candidate.market.asset === "USDD"
            ? [
                "Assumes 1:1 USDD/USDT value; the peg is not guaranteed.",
                "Includes PSM round-trip costs and shares the protocol exposure cap with other JustLend markets.",
              ]
            : [
                "Supplies USDT directly without conversion to another stablecoin.",
              ]),
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
      name: "Yield scenario",
      objective: "Compare net returns after reserving round-trip costs.",
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
              "The USDD route is for comparison only. This version does not execute USDD transactions.",
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
        name: "Net return first",
        objective:
          "The highest estimated net return among the allocations compared.",
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
          name: "Liquidity first",
          objective:
            "Keep more cash available while preserving a positive estimated net return.",
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
        "After round-trip costs and constraints, none of the compared allocations beats holding cash.",
      );
    }
  }
  return result;
}
