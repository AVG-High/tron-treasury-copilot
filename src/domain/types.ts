export type StrategyId = "wallet" | "justlend-usdt" | "justlend-usdd";
export type DataMode = "live" | "demo";
export interface Expense {
  id: string;
  label: string;
  amountUSDT: string;
  dueInDays: number;
}
export interface TreasuryIntent {
  capitalUSDT: string;
  horizonDays: number;
  emergencyUSDT: string;
  expenses: Expense[];
  maxUSDDExposurePct: number;
  maxProtocolExposurePct: number;
  allowVolatile: false;
  allowLeverage: false;
}
export interface Evidence {
  label: string;
  url: string;
  fetchedAt: string;
  note?: string;
}
export interface Market {
  id: Exclude<StrategyId, "wallet">;
  name: string;
  asset: "USDT" | "USDD";
  baseApy: string | null;
  rewardApy: string | null;
  cashUSDT: string | null;
  active: boolean;
  tokenAddress: string;
  marketAddress: string;
  quality: "verified" | "unavailable" | "stale" | "demo";
  evidence: Evidence[];
  warnings: string[];
}
export interface PsmState {
  available: boolean;
  toUSDDEnabled: boolean;
  fromUSDDEnabled: boolean;
  toUSDDFeePct: string | null;
  fromUSDDFeePct: string | null;
  availableUSDT: string | null;
  evidence: Evidence[];
  warnings: string[];
}
export interface MarketSnapshot {
  mode: DataMode;
  fetchedAt: string;
  markets: Market[];
  psm: PsmState;
  warnings: string[];
}
export interface CostAssumptions {
  justlendUsdtRoundTripUSDT: string;
  justlendUsddRoundTripUSDT: string;
  source: "user-assumption" | "wallet-estimate";
  includeIncentives: boolean;
}
export interface Allocation {
  strategy: StrategyId;
  amountUSDT: string;
  grossYieldUSDT: string;
  incentiveYieldUSDT: string;
  costUSDT: string;
  netYieldUSDT: string;
  reasons: string[];
}
export interface Plan {
  id: string;
  name: string;
  objective: string;
  allocations: Allocation[];
  reserveUSDT: string;
  freeCashUSDT: string;
  investedUSDT: string;
  grossYieldUSDT: string;
  incentiveYieldUSDT: string;
  costUSDT: string;
  netYieldUSDT: string;
  breakevenDays: number | null;
  executable: boolean;
  warnings: string[];
}
export interface Exclusion {
  strategy: string;
  code: string;
  reason: string;
}
export interface PlanningResult {
  version: string;
  createdAt: string;
  intent: TreasuryIntent;
  snapshot: MarketSnapshot;
  costs: CostAssumptions;
  reserveUSDT: string;
  availableUSDT: string;
  feasible: boolean;
  errors: string[];
  plans: Plan[];
  exclusions: Exclusion[];
}
export interface ParseResult {
  intent: Partial<TreasuryIntent>;
  questions: string[];
  source: "ai" | "manual";
  message: string;
}
export interface WalletPosition {
  marketId: Exclude<StrategyId, "wallet">;
  underlyingAmount: string;
  underlyingAsset: "USDT" | "USDD";
  jTokenBalanceRaw: string;
  collateral: boolean;
}
export interface WalletState {
  address: string;
  network: "tron-mainnet";
  usdt: string;
  usdd: string | null;
  trx: string;
  energyRemaining: number;
  bandwidthRemaining: number;
  positions: WalletPosition[];
  hasBorrow: boolean;
  fetchedAt: string;
  warnings: string[];
}
export type TransactionAction =
  "approve-usdt" | "supply-usdt" | "withdraw-usdt";
export interface TransactionPreview {
  action: TransactionAction;
  owner: string;
  to: string;
  spender: string | null;
  amount: string;
  asset: "USDT";
  functionSelector: string;
  parameters: unknown[];
  feeLimitSun: number;
  estimatedEnergy: number | null;
  estimatedFeeTRX: string | null;
  expiresAt: string;
  warnings: string[];
  unsignedTransaction: unknown;
  digest: string;
}
export interface TransactionRecord {
  id: string;
  txid: string;
  action: TransactionAction;
  amount: string;
  owner: string;
  submittedAt: string;
  status: "pending" | "confirmed" | "failed" | "unknown";
  actualFeeTRX?: string;
  error?: string;
  planId?: string;
}
