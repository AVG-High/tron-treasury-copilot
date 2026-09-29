import { z } from "zod";
import type { WalletState } from "../domain/types";

const unsigned = z
  .string()
  .max(100)
  .regex(/^\d+(\.\d+)?$/);
const positionSchema = z.object({
  marketId: z.enum(["justlend-usdt", "justlend-usdd"]),
  underlyingAmount: unsigned,
  underlyingAsset: z.enum(["USDT", "USDD"]),
  jTokenBalanceRaw: z.string().max(100).regex(/^\d+$/),
  collateral: z.boolean(),
});
export const observedWalletSchema = z.object({
  address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
  network: z.literal("tron-mainnet"),
  usdt: unsigned,
  usdd: unsigned.nullable(),
  trx: unsigned,
  energyRemaining: z.number().int().nonnegative(),
  bandwidthRemaining: z.number().int().nonnegative(),
  positions: z
    .array(positionSchema)
    .max(2)
    .refine(
      (items) =>
        new Set(items.map((p) => p.marketId)).size === items.length &&
        items.every(
          (p) =>
            p.underlyingAsset ===
            (p.marketId === "justlend-usdt" ? "USDT" : "USDD"),
        ),
    ),
  hasBorrow: z.boolean(),
  fetchedAt: z.iso.datetime(),
  warnings: z.array(z.string().max(2000)).max(30),
});
export const OBSERVATION_KEY = "tron-treasury-copilot-observations-v1";
const journalSchema = z.object({
  version: z.literal(1),
  wallets: z.array(observedWalletSchema).max(96),
});
export interface ObservationJournal {
  wallets: WalletState[];
  error: string | null;
}

export function readObservations(
  storage: Pick<Storage, "getItem"> = localStorage,
): ObservationJournal {
  try {
    const raw = storage.getItem(OBSERVATION_KEY);
    if (raw === null) return { wallets: [], error: null };
    return {
      wallets: journalSchema.parse(JSON.parse(raw)).wallets,
      error: null,
    };
  } catch {
    return {
      wallets: [],
      error:
        "관측 기록을 읽지 못해 저장을 중지했습니다. 기존 데이터는 그대로 보존합니다.",
    };
  }
}

/** Separate observation journal: never interpreted as complete cash-flow history. */
export function appendObservation(
  wallet: WalletState,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  now = Date.now(),
): ObservationJournal {
  const journal = readObservations(storage);
  if (journal.error) throw new Error(journal.error);
  const validated = observedWalletSchema.parse(wallet);
  const at = Date.parse(validated.fetchedAt);
  if (!Number.isFinite(now) || at > now || now - at > 300_000)
    throw new Error("오래되었거나 미래 시각인 지갑 관측은 저장하지 않습니다.");
  const previous = journal.wallets.find((w) => w.address === validated.address);
  if (previous && Date.parse(previous.fetchedAt) >= at) return journal;
  const wallets = [validated, ...journal.wallets].slice(0, 96);
  storage.setItem(OBSERVATION_KEY, JSON.stringify({ version: 1, wallets }));
  return { wallets, error: null };
}
