import Decimal from "decimal.js";
import { z } from "zod";

/** Human-readable USDT amounts: never binary floats, scientific notation or > 6 decimals. */
export const amountSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)(\.\d{1,6})?$/,
    "0 이상인 금액을 소수점 아래 6자리까지 입력해 주세요.",
  )
  .refine((value) => {
    try {
      return new Decimal(value).lte("1000000000");
    } catch {
      return false;
    }
  }, "지원하는 최대 금액 10억 USDT를 초과했습니다.");

export const intentSchema = z
  .object({
    capitalUSDT: amountSchema,
    horizonDays: z.number().int().min(1).max(3650),
    emergencyUSDT: amountSchema,
    expenses: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            label: z.string().trim().min(1).max(160),
            amountUSDT: amountSchema,
            dueInDays: z.number().int().min(0).max(3650),
          })
          .strict(),
      )
      .max(100)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
        "지출 항목의 ID가 중복되었습니다.",
      ),
    maxUSDDExposurePct: z.number().min(0).max(100),
    maxProtocolExposurePct: z.number().min(0).max(100),
    allowVolatile: z.literal(false),
    allowLeverage: z.literal(false),
  })
  .strict();

export const costsSchema = z
  .object({
    justlendUsdtRoundTripUSDT: amountSchema,
    justlendUsddRoundTripUSDT: amountSchema,
    source: z.enum(["user-assumption", "wallet-estimate"]),
    includeIncentives: z.boolean(),
  })
  .strict();

/** safeParse result: callers must show issues instead of silently replacing invalid input. */
export const validateIntent = (input: unknown) => intentSchema.safeParse(input);
