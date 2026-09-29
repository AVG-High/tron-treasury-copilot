import Decimal from "decimal.js";
import { costsSchema, intentSchema } from "./schema";
import type {
  CostAssumptions,
  Market,
  MarketSnapshot,
  PlanningResult,
  StrategyId,
  TreasuryIntent,
  WalletPosition,
  WalletState,
} from "./types";

const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const DAY_MS = 86_400_000;
const FRESH_MS = 300_000;
const FUTURE_SKEW_MS = 30_000;
const format = (value: Decimal) => value.toFixed(6);
const money = (value: unknown, max = "1000000000000000") => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    return null;
  const parsed = new D(value);
  return parsed.isFinite() && parsed.lte(max) ? parsed : null;
};
const timestamp = (value: string | number) =>
  typeof value === "number" ? value : Date.parse(value);
const isFresh = (value: string, now: number) => {
  const time = timestamp(value);
  return (
    Number.isFinite(time) &&
    time <= now + FUTURE_SKEW_MS &&
    now - time <= FRESH_MS
  );
};
const marketAsset = (id: string) =>
  id === "justlend-usdt" ? "USDT" : id === "justlend-usdd" ? "USDD" : null;
const validPositions = (positions: WalletPosition[]) =>
  new Set(positions.map((position) => position.marketId)).size ===
    positions.length &&
  positions.every(
    (position) =>
      marketAsset(position.marketId) === position.underlyingAsset &&
      money(position.underlyingAmount) !== null &&
      /^(0|[1-9]\d{0,79})$/.test(position.jTokenBalanceRaw),
  );
const marketQuality = (market: Market, now: number) =>
  market.quality === "verified" &&
  marketAsset(market.id) === market.asset &&
  market.evidence.length > 0 &&
  market.evidence.every((evidence) => isFresh(evidence.fetchedAt, now));

export interface MonitorAlert {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  strategy?: StrategyId;
}
export interface RateComparison {
  strategy: Exclude<StrategyId, "wallet">;
  principalUSDT: string;
  originalBaseApy: string | null;
  currentBaseApy: string | null;
  originalHorizonDays: number;
  originalBaseYieldUSDT: string | null;
  currentBaseYieldUSDT: string | null;
  deltaBaseYieldUSDT: string | null;
}
export interface MonitorResult {
  kind: "read-only-monitor";
  checkedAt: string;
  originalMode: "live" | "demo";
  elapsedDays: number | null;
  remainingDays: number | null;
  remainingIntent: TreasuryIntent | null;
  alerts: MonitorAlert[];
  rateComparisons: RateComparison[];
  reserve: {
    requiredUSDT: string;
    walletUSDT: string | null;
    shortfallUSDT: string | null;
  } | null;
  proposal: {
    kind: "original-capital-scenario";
    capitalUSDT: string;
    intent: TreasuryIntent;
    costs: CostAssumptions;
    requiresReview: true;
    executable: false;
  } | null;
  actualNetYieldUSDT: null;
}

/**
 * A saved-assumption monitor, not an execution instruction or performance ledger.
 * Elapsed days mean complete 24-hour intervals in UTC; crossing midnight alone
 * never consumes a day. Due/overdue expenses remain reserved until the user edits
 * their conditions. Wallet balances never replace the original planning capital.
 * Any replan is a new scenario with full round-trip cost assumptions, NOT the net
 * benefit of moving an existing position (which requires a transaction ledger).
 */
export function monitorPlan(input: {
  original: PlanningResult;
  selectedPlanId: string;
  savedAt: string;
  snapshot: MarketSnapshot;
  wallet?: WalletState | null;
  now?: string | number;
}): MonitorResult {
  const { original, selectedPlanId, savedAt, snapshot, wallet } = input;
  const now = timestamp(input.now ?? Date.now());
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15)
    throw new Error("관측 시각을 확인해 주세요.");
  const result: MonitorResult = {
    kind: "read-only-monitor",
    checkedAt: new Date(now).toISOString(),
    originalMode: original.snapshot.mode,
    elapsedDays: null,
    remainingDays: null,
    remainingIntent: null,
    alerts: [],
    rateComparisons: [],
    reserve: null,
    proposal: null,
    actualNetYieldUSDT: null,
  };
  const alert = (
    code: string,
    severity: MonitorAlert["severity"],
    message: string,
    strategy?: StrategyId,
  ) =>
    result.alerts.push({
      code,
      severity,
      message,
      ...(strategy ? { strategy } : {}),
    });
  const selected = original.plans.filter((plan) => plan.id === selectedPlanId);
  const parsedIntent = intentSchema.safeParse(original.intent);
  const parsedCosts = costsSchema.safeParse(original.costs);
  if (
    !original.feasible ||
    selected.length !== 1 ||
    !parsedIntent.success ||
    !parsedCosts.success ||
    money(selected[0].costUSDT) === null ||
    new Set(selected[0].allocations.map((row) => row.strategy)).size !==
      selected[0].allocations.length ||
    selected[0].allocations.some(
      (row) =>
        (row.strategy !== "wallet" && marketAsset(row.strategy) === null) ||
        money(row.amountUSDT) === null,
    )
  ) {
    alert(
      "invalid-original-plan",
      "critical",
      "저장된 조건과 선택한 계획을 검증하지 못했습니다. 새 조건을 확인해 다시 계산해 주세요.",
    );
    return result;
  }
  const plan = selected[0];
  const intent = parsedIntent.data;
  if (original.snapshot.mode === "demo")
    alert(
      "demo-baseline",
      "info",
      "원래 계획은 데모 가정입니다. 현재 데이터와의 비교도 시나리오이며 실제 투자 성과가 아닙니다.",
    );
  const savedTime = timestamp(savedAt);
  const originalTime = timestamp(original.createdAt);
  const validClock =
    Number.isFinite(savedTime) &&
    Number.isFinite(originalTime) &&
    savedTime <= now + FUTURE_SKEW_MS &&
    originalTime <= now + FUTURE_SKEW_MS &&
    savedTime >= originalTime - FUTURE_SKEW_MS;
  if (!validClock) {
    alert(
      "invalid-plan-time",
      "critical",
      "계획 생성·저장 시각이 없거나 미래/역순입니다. 남은 기간과 지출일을 계산할 수 없습니다.",
    );
  } else {
    result.elapsedDays = Math.max(0, Math.floor((now - savedTime) / DAY_MS));
    result.remainingDays = Math.max(0, intent.horizonDays - result.elapsedDays);
    if (result.remainingDays === 0) {
      alert(
        "horizon-expired",
        "warning",
        "원래 운용 기간이 끝났습니다. 새 운용 기간과 지출 조건을 직접 확인해야 합니다.",
      );
    } else {
      result.remainingIntent = {
        ...intent,
        horizonDays: result.remainingDays,
        expenses: intent.expenses.map((expense) => ({
          ...expense,
          dueInDays: Math.max(0, expense.dueInDays - result.elapsedDays!),
        })),
      };
    }
    for (const expense of intent.expenses) {
      const days = expense.dueInDays - result.elapsedDays;
      if (days <= 0)
        alert(
          `expense-due:${expense.id}`,
          "warning",
          `‘${expense.label}’의 지급 예정일이 도래했습니다. 지급 완료를 추정하지 않으며 ${expense.amountUSDT} USDT는 계속 예약합니다.`,
        );
      else if (days <= 3)
        alert(
          `expense-soon:${expense.id}`,
          "info",
          `‘${expense.label}’ 지급까지 ${days}일 남았습니다. 예약 자금을 확인해 주세요.`,
        );
    }
  }
  const snapshotFresh =
    snapshot.mode === "live" && isFresh(snapshot.fetchedAt, now);
  if (snapshot.mode !== "live")
    alert(
      "live-data-required",
      "warning",
      "변화 감지에는 실시간 데이터가 필요합니다. 데모 값으로 현재 상태를 추정하지 않습니다.",
    );
  else if (!snapshotFresh)
    alert(
      "stale-market-snapshot",
      "warning",
      "시장 관측 시각이 5분을 넘었거나 미래/잘못된 시각입니다. 새 조회가 필요합니다.",
    );

  for (const allocation of plan.allocations) {
    if (allocation.strategy === "wallet") continue;
    const oldMatches = original.snapshot.markets.filter(
      (market) => market.id === allocation.strategy,
    );
    const currentMatches = snapshot.markets.filter(
      (market) => market.id === allocation.strategy,
    );
    const oldMarket = oldMatches.length === 1 ? oldMatches[0] : null;
    const current = currentMatches.length === 1 ? currentMatches[0] : null;
    const identityMatches =
      original.snapshot.mode === "demo" ||
      (oldMarket &&
        current &&
        oldMarket.tokenAddress === current.tokenAddress &&
        oldMarket.marketAddress === current.marketAddress);
    const currentVerified =
      snapshotFresh &&
      current !== null &&
      marketQuality(current, now) &&
      Boolean(identityMatches);
    const oldProvenance =
      original.snapshot.mode === "demo" ||
      (validClock &&
        isFresh(original.snapshot.fetchedAt, originalTime) &&
        oldMarket !== null &&
        marketQuality(oldMarket, originalTime));
    const oldRate =
      oldProvenance &&
      oldMarket &&
      oldMarket.asset === marketAsset(allocation.strategy)
        ? money(oldMarket.baseApy, "1000000")
        : null;
    const newRate = currentVerified ? money(current!.baseApy, "1000000") : null;
    const principal = new D(allocation.amountUSDT);
    const yieldAt = (rate: Decimal | null) =>
      rate === null
        ? null
        : principal
            .mul(rate.plus(1).pow(new D(intent.horizonDays).div(365)).minus(1))
            .toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const originalYield = yieldAt(oldRate);
    const currentYield = yieldAt(newRate);
    result.rateComparisons.push({
      strategy: allocation.strategy,
      principalUSDT: format(principal),
      originalBaseApy: oldRate?.toString() ?? null,
      currentBaseApy: newRate?.toString() ?? null,
      originalHorizonDays: intent.horizonDays,
      originalBaseYieldUSDT:
        originalYield === null ? null : format(originalYield),
      currentBaseYieldUSDT: currentYield === null ? null : format(currentYield),
      deltaBaseYieldUSDT:
        originalYield === null || currentYield === null
          ? null
          : format(currentYield.minus(originalYield)),
    });
    if (!identityMatches)
      alert(
        "market-identity-changed",
        "critical",
        "저장 당시와 현재 시장의 토큰 또는 계약 주소가 다릅니다. 같은 기호만으로 금리를 비교하지 않습니다.",
        allocation.strategy,
      );
    if (oldRate === null)
      alert(
        "original-rate-unavailable",
        "warning",
        "원래 금리 또는 저장 당시 출처를 검증하지 못했습니다. 이전 금리를 0%로 추정하지 않습니다.",
        allocation.strategy,
      );
    if (newRate === null)
      alert(
        "market-unavailable",
        "warning",
        "현재 기본 금리·시장 출처를 검증하지 못했습니다. 결측을 0%로 처리하지 않습니다.",
        allocation.strategy,
      );
    else if (oldRate !== null && !newRate.eq(oldRate))
      alert(
        "base-rate-changed",
        "info",
        "기본 APY가 원래 가정과 달라졌습니다. 같은 원금과 원래 기간으로 계산한 예상 이자만 비교합니다.",
        allocation.strategy,
      );
    if (currentVerified && !current!.active)
      alert(
        "market-inactive",
        "warning",
        "현재 신규 예치가 비활성화된 시장입니다. 기존 포지션의 회수 가능 여부는 별도로 확인해야 합니다.",
        allocation.strategy,
      );
    if (currentVerified && original.costs.includeIncentives) {
      const oldReward = oldMarket
        ? money(oldMarket.rewardApy, "1000000")
        : null;
      const newReward = money(current!.rewardApy, "1000000");
      if (newReward === null)
        alert(
          "incentive-unavailable",
          "warning",
          "선택한 인센티브의 현재 보상률을 확인하지 못했습니다.",
          allocation.strategy,
        );
      else if (oldReward !== null && !newReward.eq(oldReward))
        alert(
          "incentive-rate-changed",
          "info",
          "인센티브 보상률이 달라졌습니다. 기본 이자 변화에는 보상을 합산하지 않았습니다.",
          allocation.strategy,
        );
    }
  }

  const required = intent.expenses
    .reduce(
      (sum, expense) => sum.plus(expense.amountUSDT),
      new D(intent.emergencyUSDT),
    )
    .plus(plan.costUSDT);
  result.reserve = {
    requiredUSDT: format(required),
    walletUSDT: null,
    shortfallUSDT: null,
  };
  const walletFresh =
    wallet !== undefined &&
    wallet !== null &&
    wallet.network === "tron-mainnet" &&
    wallet.address.length > 0 &&
    isFresh(wallet.fetchedAt, now) &&
    money(wallet.usdt) !== null &&
    validPositions(wallet.positions);
  const needsUsddExit =
    plan.allocations.some((row) => row.strategy === "justlend-usdd") ||
    (walletFresh &&
      wallet.positions.some((row) => row.marketId === "justlend-usdd"));
  if (
    snapshotFresh &&
    needsUsddExit &&
    (!snapshot.psm.available ||
      !snapshot.psm.fromUSDDEnabled ||
      money(snapshot.psm.fromUSDDFeePct, "99.999999") === null ||
      money(snapshot.psm.availableUSDT) === null ||
      snapshot.psm.evidence.length === 0 ||
      snapshot.psm.evidence.some(
        (evidence) => !isFresh(evidence.fetchedAt, now),
      ))
  )
    alert(
      "usdd-exit-unavailable",
      "warning",
      "USDD에서 USDT로 돌아오는 현재 PSM 경로·비용·유동성을 확인하지 못했습니다. JustLend 시장 현금만으로 USDT 지출을 충족한다고 가정하지 않습니다.",
      "justlend-usdd",
    );
  if (!wallet) {
    alert(
      "wallet-not-observed",
      "info",
      "현재 지갑을 조회하면 USDT 예약금과 보유 포지션의 회수 유동성을 확인할 수 있습니다.",
    );
  } else if (!walletFresh) {
    alert(
      "wallet-unavailable",
      "warning",
      "지갑 시각·자산·중복 포지션을 검증하지 못했습니다. 예약금 부족액을 추정하지 않습니다.",
    );
  } else {
    const balance = new D(wallet.usdt);
    const shortfall = D.max(0, required.minus(balance));
    result.reserve.walletUSDT = format(balance);
    result.reserve.shortfallUSDT = format(shortfall);
    if (shortfall.gt(0))
      alert(
        "reserve-shortfall",
        "critical",
        `현재 지갑 USDT가 지출·비상금·원래 왕복 비용 예약보다 ${format(shortfall)} USDT 적습니다. 이미 지출한 비용도 원장이 없어 계속 예약하므로 조건을 검토해 주세요.`,
      );
    if (wallet.hasBorrow)
      alert(
        "borrow-restriction",
        "critical",
        "차입이 있는 계정은 이 버전에서 회수를 준비할 수 없습니다. 예약금과 담보를 먼저 확인해 주세요.",
      );
    for (const position of wallet.positions) {
      const matches = snapshot.markets.filter(
        (market) => market.id === position.marketId,
      );
      const market = matches.length === 1 ? matches[0] : null;
      const cash =
        snapshotFresh && market && marketQuality(market, now)
          ? money(market.cashUSDT)
          : null;
      if (cash === null)
        alert(
          "exit-liquidity-unavailable",
          "warning",
          "보유 포지션의 현재 시장 회수 유동성을 확인하지 못했습니다.",
          position.marketId,
        );
      else if (cash.lt(position.underlyingAmount))
        alert(
          "exit-liquidity-shortfall",
          "critical",
          "시장 현금이 현재 보유 포지션 수량보다 적습니다. 즉시 전액 회수를 가정할 수 없습니다. USDD 수량 비교는 USDT 전환 가능성을 보장하지 않습니다.",
          position.marketId,
        );
    }
  }
  if (snapshotFresh && result.remainingIntent) {
    result.proposal = {
      kind: "original-capital-scenario",
      capitalUSDT: intent.capitalUSDT,
      intent: structuredClone(result.remainingIntent),
      costs: structuredClone(parsedCosts.data),
      requiresReview: true,
      executable: false,
    };
  }
  return result;
}

export interface WalletObservationComparison {
  status: "comparable" | "unavailable";
  reason?: string;
  positions: {
    marketId: WalletPosition["marketId"];
    asset: WalletPosition["underlyingAsset"];
    underlyingDelta: string | null;
    sharesChanged: boolean | null;
    previousRawShares: string | null;
    currentRawShares: string | null;
  }[];
  actualNetYieldUSDT: null;
  warnings: string[];
}

/** Two balance observations cannot establish deposits, withdrawals or actual yield. */
export function compareWalletObservations(
  previous: WalletState,
  current: WalletState,
  observedAt: string | number = Date.now(),
): WalletObservationComparison {
  const result: WalletObservationComparison = {
    status: "unavailable",
    positions: [],
    actualNetYieldUSDT: null,
    warnings: [
      "관측 사이 입출금·이전·보상·비용 원장이 없습니다. 지분 수량이 같아도 가치 변화는 실제 순수익이나 실현 수익이 아닙니다.",
    ],
  };
  const now = timestamp(observedAt);
  const earlier = timestamp(previous.fetchedAt);
  const later = timestamp(current.fetchedAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(earlier) ||
    !isFresh(current.fetchedAt, now) ||
    earlier >= later ||
    previous.network !== "tron-mainnet" ||
    current.network !== previous.network ||
    !previous.address ||
    current.address !== previous.address ||
    !validPositions(previous.positions) ||
    !validPositions(current.positions)
  ) {
    result.reason =
      "같은 메인넷 계정의 순서가 확인되는 두 관측이 필요합니다. 중복·역순·오래된 현재 관측·자산 불일치는 비교하지 않습니다.";
    return result;
  }
  result.status = "comparable";
  for (const id of new Set(
    [...previous.positions, ...current.positions].map((row) => row.marketId),
  )) {
    const oldPosition = previous.positions.find((row) => row.marketId === id);
    const newPosition = current.positions.find((row) => row.marketId === id);
    result.positions.push({
      marketId: id,
      asset: (newPosition ?? oldPosition)!.underlyingAsset,
      underlyingDelta:
        oldPosition && newPosition
          ? new D(newPosition.underlyingAmount)
              .minus(oldPosition.underlyingAmount)
              .toFixed(18)
          : null,
      sharesChanged:
        oldPosition && newPosition
          ? oldPosition.jTokenBalanceRaw !== newPosition.jTokenBalanceRaw
          : null,
      previousRawShares: oldPosition?.jTokenBalanceRaw ?? null,
      currentRawShares: newPosition?.jTokenBalanceRaw ?? null,
    });
  }
  if (result.positions.some((row) => row.underlyingDelta === null))
    result.warnings.push(
      "한 관측에 없는 포지션은 0으로 보정하지 않았습니다. 신규 예치·회수·이전 여부를 원장에서 확인해야 합니다.",
    );
  return result;
}
