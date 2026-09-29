import { z } from "zod";
import { PLANNER_VERSION } from "../domain/planner";
import { costsSchema, intentSchema } from "../domain/schema";
import type { CostAssumptions, TreasuryIntent } from "../domain/types";

const timestampSchema = z.iso.datetime({ offset: true });
const storedConditionsSchema = z
  .object({
    version: z.literal(PLANNER_VERSION),
    createdAt: timestampSchema,
    feasible: z.literal(true),
    intent: intentSchema,
    costs: costsSchema,
    snapshot: z.object({ mode: z.enum(["live", "demo"]) }),
    selectedPlanId: z.string().min(1).max(100),
    plans: z
      .array(z.object({ id: z.string().min(1).max(100) }))
      .min(1)
      .max(20),
  })
  .refine(
    (stored) =>
      new Set(stored.plans.map((plan) => plan.id)).size ===
        stored.plans.length &&
      stored.plans.some((plan) => plan.id === stored.selectedPlanId),
    "저장한 계획의 선택 항목을 확인할 수 없습니다.",
  );

export interface RestoredPlanConditions {
  /** An expired horizon is intentionally 0 and cannot pass planner validation. */
  intent: TreasuryIntent;
  costs: CostAssumptions;
  elapsedDays: number;
  requiresNewHorizon: boolean;
}

/**
 * Restores inputs only. The time anchor is the original PlanningResult.createdAt,
 * not the later save/export timestamp. No calculated plan or prior confirmation
 * is restored. Full elapsed 24-hour UTC intervals avoid local-midnight/DST jumps.
 * Due/overdue expenses remain reserved until the user explicitly edits them.
 */
export function restorePlanConditions(
  stored: unknown,
  now: number | string = Date.now(),
): RestoredPlanConditions {
  const parsed = storedConditionsSchema.safeParse(stored);
  if (!parsed.success)
    throw new Error(
      "저장된 계획의 조건·선택 항목·생성 시각을 확인하지 못했습니다.",
    );
  const currentTime =
    typeof now === "number"
      ? now
      : timestampSchema.safeParse(now).success
        ? Date.parse(now)
        : Number.NaN;
  if (!Number.isFinite(currentTime) || Math.abs(currentTime) > 8.64e15)
    throw new Error(
      "현재 시각을 확인하지 못해 저장된 조건을 불러올 수 없습니다.",
    );
  const originalTime = Date.parse(parsed.data.createdAt);
  if (!Number.isFinite(originalTime) || originalTime > currentTime + 30_000)
    throw new Error(
      "원래 계획의 생성 시각이 미래입니다. 기기 시각과 저장 기록을 확인해 주세요.",
    );
  const elapsedDays = Math.max(
    0,
    Math.floor((currentTime - originalTime) / 86_400_000),
  );
  const horizonDays = Math.max(0, parsed.data.intent.horizonDays - elapsedDays);
  return {
    intent: {
      ...parsed.data.intent,
      horizonDays,
      expenses: parsed.data.intent.expenses.map((expense) => ({
        ...expense,
        dueInDays: Math.max(0, expense.dueInDays - elapsedDays),
      })),
    },
    costs: { ...parsed.data.costs },
    elapsedDays,
    requiresNewHorizon: horizonDays === 0,
  };
}
