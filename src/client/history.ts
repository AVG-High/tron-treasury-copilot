import { z } from "zod";
import type { PlanningResult, Plan, TransactionRecord } from "../domain/types";
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const savedSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  mode: z.enum(["live", "demo"]),
  name: z.string(),
  capitalUSDT: decimal,
  reserveUSDT: decimal,
  investedUSDT: decimal,
  expectedNetUSDT: decimal,
  horizonDays: z.number(),
  assumptions: z.string(),
  plan: z.unknown(),
});
const txSchema = z.object({
  id: z.string(),
  txid: z.string().regex(/^[a-f0-9]{64}$/i),
  action: z.enum(["approve-usdt", "supply-usdt", "withdraw-usdt"]),
  amount: decimal,
  owner: z.string(),
  submittedAt: z.string(),
  status: z.enum(["pending", "confirmed", "failed", "unknown"]),
  actualFeeTRX: decimal.optional(),
  error: z.string().optional(),
  planId: z.string().optional(),
});
export type SavedPlan = z.infer<typeof savedSchema>;
const KEY = "tron-treasury-copilot-history-v1";
export function readHistory(): {
  plans: SavedPlan[];
  transactions: TransactionRecord[];
  error: string | null;
} {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { plans: [], transactions: [], error: null };
    const parsed = z
      .object({
        version: z.literal(1),
        plans: z.array(savedSchema).max(50),
        transactions: z.array(txSchema).max(200),
      })
      .parse(JSON.parse(raw));
    return { ...parsed, error: null };
  } catch {
    return {
      plans: [],
      transactions: [],
      error:
        "브라우저 기록을 읽을 수 없습니다. 기존 데이터를 보존하기 위해 저장을 중지했습니다.",
    };
  }
}
export function writeHistory(
  plans: SavedPlan[],
  transactions: TransactionRecord[],
): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      plans: plans.slice(0, 50),
      transactions: transactions.slice(0, 200),
    }),
  );
}
export function toSavedPlan(result: PlanningResult, plan: Plan): SavedPlan {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    mode: result.snapshot.mode,
    name: plan.name,
    capitalUSDT: result.intent.capitalUSDT,
    reserveUSDT: result.reserveUSDT,
    investedUSDT: plan.investedUSDT,
    expectedNetUSDT: plan.netYieldUSDT,
    horizonDays: result.intent.horizonDays,
    assumptions: `수익률 유지 가정 · 비용 ${result.costs.source === "user-assumption" ? "사용자 가정" : "지갑 추정"} · 보상 ${result.costs.includeIncentives ? "포함" : "제외"}`,
    plan: { ...result, selectedPlanId: plan.id },
  };
}
export function exportJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
