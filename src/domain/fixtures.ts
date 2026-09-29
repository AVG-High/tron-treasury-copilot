import type { CostAssumptions, MarketSnapshot, TreasuryIntent } from "./types";

export const defaultIntent: TreasuryIntent = {
  capitalUSDT: "10000",
  horizonDays: 30,
  emergencyUSDT: "500",
  expenses: [
    {
      id: "payroll",
      label: "Payment next week",
      amountUSDT: "3000",
      dueInDays: 7,
    },
    {
      id: "operations",
      label: "Operating costs next month",
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
          label: "Sample data · not live rates",
          url: "https://docs.justlend.org/developers/apis/",
          fetchedAt: fixtureTime,
          note: "Rates and liquidity are illustrative assumptions for this demo.",
        },
      ],
      warnings: [
        "Demo rates, liquidity, and addresses. Not valid for executing transactions.",
      ],
    },
    {
      id: "justlend-usdd",
      name: "JustLend USDD · via PSM",
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
          label: "Sample data · not live rates",
          url: "https://docs.justlend.org/developers/apis/",
          fetchedAt: fixtureTime,
          note: "Assumes 1:1 USDD/USDT value. The peg is not guaranteed.",
        },
      ],
      warnings: [
        "USDD can depeg. Current PSM capacity does not guarantee future exits.",
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
        label: "PSM sample data",
        url: "https://docs.usdd.io/",
        fetchedAt: fixtureTime,
      },
    ],
    warnings: [
      "PSM capacity and fees are illustrative, not a verified live route.",
    ],
  },
  warnings: ["DEMO: rates, liquidity, and costs are illustrative."],
};
