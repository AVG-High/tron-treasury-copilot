import type { CostAssumptions, MarketSnapshot, TreasuryIntent } from "./types";

export const defaultIntent: TreasuryIntent = {
  capitalUSDT: "10000",
  horizonDays: 30,
  emergencyUSDT: "500",
  expenses: [
    {
      id: "payroll",
      label: "다음 주 지급액",
      amountUSDT: "3000",
      dueInDays: 7,
    },
    {
      id: "operations",
      label: "다음 달 운영비",
      amountUSDT: "1000",
      dueInDays: 30,
    },
  ],
  maxUSDDExposurePct: 20,
  maxProtocolExposurePct: 70,
  allowVolatile: false,
  allowLeverage: false,
};

/** Illustration only; these amounts are not live TRON fee estimates. */
export const defaultCosts: CostAssumptions = {
  justlendUsdtRoundTripUSDT: "4",
  justlendUsddRoundTripUSDT: "8",
  source: "user-assumption",
  includeIncentives: false,
};

const fixtureTime = new Date().toISOString();
export const demoSnapshot: MarketSnapshot = {
  mode: "demo",
  fetchedAt: fixtureTime,
  markets: [
    {
      id: "justlend-usdt",
      name: "JustLend USDT",
      asset: "USDT",
      baseApy: "0.058",
      rewardApy: "0.012",
      cashUSDT: "2000000",
      active: true,
      tokenAddress: "demo-usdt-token",
      marketAddress: "demo-usdt-market",
      quality: "demo",
      evidence: [
        {
          label: "예시 데이터 · 실시간 금리 아님",
          url: "https://docs.justlend.org/developers/apis/",
          fetchedAt: fixtureTime,
          note: "금리와 유동성은 시연을 위해 설정한 가정값입니다.",
        },
      ],
      warnings: [
        "데모 금리·유동성·주소입니다. 거래 실행에는 사용할 수 없습니다.",
      ],
    },
    {
      id: "justlend-usdd",
      name: "JustLend USDD · PSM 경유",
      asset: "USDD",
      baseApy: "0.076",
      rewardApy: "0.02",
      cashUSDT: "1000000",
      active: true,
      tokenAddress: "demo-usdd-token",
      marketAddress: "demo-usdd-market",
      quality: "demo",
      evidence: [
        {
          label: "예시 데이터 · 실시간 금리 아님",
          url: "https://docs.justlend.org/developers/apis/",
          fetchedAt: fixtureTime,
          note: "USDD와 USDT의 1:1 가정이며 페그를 보장하지 않습니다.",
        },
      ],
      warnings: [
        "USDD는 페그가 이탈할 수 있습니다. 현재 PSM 가용량은 미래 회수를 보장하지 않습니다.",
      ],
    },
  ],
  psm: {
    available: true,
    toUSDDEnabled: true,
    fromUSDDEnabled: true,
    toUSDDFeePct: "0",
    fromUSDDFeePct: "0",
    availableUSDT: "1000000",
    evidence: [
      {
        label: "PSM 예시 데이터",
        url: "https://docs.usdd.io/",
        fetchedAt: fixtureTime,
      },
    ],
    warnings: [
      "PSM 가용량과 수수료는 예시이며 실시간 경로를 검증한 값이 아닙니다.",
    ],
  },
  warnings: ["데모: 금리·유동성·비용은 예시 데이터입니다."],
};
