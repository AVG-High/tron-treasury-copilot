import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { z } from "zod";
import Decimal from "decimal.js";
import { planTreasury } from "../domain/planner.js";
import { demoSnapshot } from "../domain/fixtures.js";
import { amountSchema, costsSchema, intentSchema } from "../domain/schema.js";
import {
  getLiveSnapshot,
  getWalletState,
  prepareTransaction,
  getTransactionStatus,
} from "../chain/index.js";
import { IntentServiceError, isAiConfigured, parseIntent } from "./intent.js";

const services = {
  getLiveSnapshot,
  getWalletState,
  prepareTransaction,
  getTransactionStatus,
  parseIntent,
  planTreasury,
};
const modeSchema = z.enum(["live", "demo"]);
const addressSchema = z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
const txidSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
// No trusted round-trip wallet estimator exists yet. A caller cannot upgrade an assumption's provenance.
const submittedCostsSchema = costsSchema.refine(
  (costs) => costs.source === "user-assumption",
  "Only user assumptions can be submitted by clients.",
);
const planSchema = z
  .object({
    mode: modeSchema,
    intent: intentSchema,
    costs: submittedCostsSchema,
  })
  .strict();
const transactionSchema = z
  .object({
    action: z.enum(["approve-usdt", "supply-usdt", "withdraw-usdt"]),
    owner: addressSchema,
    amount: amountSchema,
    planning: z
      .object({
        intent: intentSchema,
        costs: submittedCostsSchema,
        planId: z.string().min(1).max(100),
        mode: z.literal("live"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (transaction) =>
      transaction.action === "approve-usdt" ||
      new Decimal(transaction.amount).gt(0),
    "Supply and withdrawal amounts must be positive.",
  );

export interface AppOptions {
  services?: Partial<typeof services>;
  aiConfigured?: boolean;
  allowedOrigins?: string[];
  production?: boolean;
  distPath?: string;
  rateLimit?: number;
  intentRateLimit?: number;
  now?: () => number;
}

const loopbackOrigins = [
  "http://127.0.0.1:4177",
  "http://localhost:4177",
  "http://127.0.0.1:4187",
  "http://localhost:4187",
];

/** Public deployment must name its exact HTTPS origin; no trust in forwarded headers. */
export function allowedOriginsFromEnv(): string[] {
  if (!process.env.PUBLIC_ORIGIN) return loopbackOrigins;
  let parsed: URL;
  try {
    parsed = new URL(process.env.PUBLIC_ORIGIN);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute origin.");
  }
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    (!isLoopback && parsed.protocol !== "https:") ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTPS origin without a path, credentials, query or fragment.",
    );
  }
  return [parsed.origin];
}

export function createApp(options: AppOptions = {}) {
  const api = { ...services, ...options.services };
  const app = express();
  const now = options.now ?? Date.now;
  const originList = options.allowedOrigins ?? allowedOriginsFromEnv();
  const origins = new Set(originList);
  const hostnames = new Set(
    originList.map((origin) => new URL(origin).hostname),
  );
  const limits = new Map<string, { count: number; reset: number }>();
  const rateLimit = options.rateLimit ?? 120;
  const intentRateLimit = options.intentRateLimit ?? 6;
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  let liveCache:
    { at: number; promise: ReturnType<typeof getLiveSnapshot> } | undefined;

  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Reject DNS rebinding and accidental exposure of the local API on arbitrary hosts.
    if (!hostnames.has(req.hostname)) {
      res.status(403).json({ error: "허용되지 않은 호스트입니다." });
      return;
    }
    next();
  });
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin && !origins.has(origin)) {
      res
        .status(403)
        .json({ error: "다른 출처에서 보낸 요청은 허용되지 않습니다." });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (!origin || !origins.has(origin)) {
        res
          .status(403)
          .json({ error: "같은 사이트의 Origin 헤더가 필요합니다." });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "application/json 요청만 허용됩니다." });
        return;
      }
    }
    const time = now();
    // Bound the limiter itself. Expired entries are removed, never evict active limits to bypass them.
    if (limits.size > 1024)
      for (const [key, value] of limits)
        if (value.reset <= time) limits.delete(key);
    const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const keys: Array<[string, number]> = [[`all:${address}`, rateLimit]];
    // Express accepts case variants and a trailing slash; those must share the paid endpoint limit.
    if (req.path.replace(/\/+$/, "").toLowerCase() === "/intent")
      keys.push(
        [`intent:${address}`, intentRateLimit],
        ["intent:global", intentRateLimit * 5],
      );
    for (const [key, cap] of keys) {
      let window = limits.get(key);
      if (!window || window.reset <= time) {
        if (limits.size >= 10_000 && !window) {
          res
            .status(429)
            .json({
              error:
                "서버 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
            });
          return;
        }
        window = { count: 0, reset: time + 60_000 };
        limits.set(key, window);
      }
      window.count += 1;
      if (window.count > cap) {
        res.setHeader(
          "Retry-After",
          Math.max(1, Math.ceil((window.reset - time) / 1000)),
        );
        res
          .status(429)
          .json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "30kb", strict: true }));

  async function liveSnapshot() {
    if (liveCache && now() - liveCache.at < 30_000) return liveCache.promise;
    const entry = { at: now(), promise: api.getLiveSnapshot() };
    liveCache = entry;
    try {
      return await entry.promise;
    } catch (error) {
      if (liveCache === entry) liveCache = undefined;
      throw error;
    }
  }

  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      app: "tron-treasury-copilot",
      version: "0.1.0",
      aiConfigured: options.aiConfigured ?? isAiConfigured(),
      network: "tron-mainnet",
      signing: "user-wallet-only",
    }),
  );
  app.get("/api/markets", async (req, res) => {
    const mode = modeSchema.parse(req.query.mode ?? "live");
    res.json(mode === "demo" ? demoSnapshot : await liveSnapshot());
  });
  app.post("/api/intent", async (req, res) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(6000) })
      .strict()
      .parse(req.body);
    res.json(await api.parseIntent(text));
  });
  app.post("/api/plan", async (req, res) => {
    const { intent, costs, mode } = planSchema.parse(req.body);
    const snapshot = mode === "demo" ? demoSnapshot : await liveSnapshot();
    res.json(api.planTreasury(intent, snapshot, costs));
  });
  app.get("/api/wallet/:address", async (req, res) => {
    const address = addressSchema.parse(req.params.address);
    res.json(await api.getWalletState(address));
  });
  app.post("/api/transactions/prepare", async (req, res) => {
    const { planning, ...transaction } = transactionSchema.parse(req.body);
    const checksPlan =
      transaction.action === "supply-usdt" ||
      (transaction.action === "approve-usdt" &&
        new Decimal(transaction.amount).gt(0) &&
        planning !== undefined);
    let minimumBalanceAfterSupply: Decimal | undefined;
    if (checksPlan) {
      if (!planning) {
        res
          .status(400)
          .json({
            error: "예치에는 확인한 실시간 계획과 비용 가정이 필요합니다.",
          });
        return;
      }
      // Fresh execution checks do not reuse the 30-second dashboard cache.
      const [wallet, snapshot] = await Promise.all([
        api.getWalletState(transaction.owner),
        api.getLiveSnapshot(),
      ]);
      const result = api.planTreasury(
        planning.intent,
        snapshot,
        planning.costs,
      );
      const selected = result.plans.find((plan) => plan.id === planning.planId);
      const allocation = selected?.allocations.find(
        (item) => item.strategy === "justlend-usdt",
      );
      const walletBalance = new Decimal(wallet.usdt);
      const amount = new Decimal(transaction.amount);
      if (
        snapshot.mode !== "live" ||
        !result.feasible ||
        !selected ||
        !allocation ||
        amount.gt(allocation.amountUSDT)
      ) {
        res
          .status(409)
          .json({
            error:
              "현재 데이터에서 선택한 계획의 예치 가능 금액을 확인하지 못했습니다. 계획을 다시 계산해 주세요.",
          });
        return;
      }
      minimumBalanceAfterSupply = new Decimal(result.reserveUSDT).plus(
        selected.costUSDT,
      );
      if (
        new Decimal(planning.intent.capitalUSDT).gt(walletBalance) ||
        walletBalance.minus(amount).lt(minimumBalanceAfterSupply)
      ) {
        res
          .status(409)
          .json({
            error:
              "지갑 잔액이 계획 자금보다 작거나 예치 후 예정 지출·비상금·비용 여유가 부족합니다. 금액을 수정해 주세요.",
          });
        return;
      }
    }
    const prepared = await api.prepareTransaction(transaction);
    if (minimumBalanceAfterSupply && planning) {
      // Simulation and construction can take several RPC round trips. Reject a balance change
      // observed during preparation rather than trusting only the earlier planning snapshot.
      const wallet = await api.getWalletState(transaction.owner);
      const balance = new Decimal(wallet.usdt);
      if (
        new Decimal(planning.intent.capitalUSDT).gt(balance) ||
        balance.minus(transaction.amount).lt(minimumBalanceAfterSupply)
      ) {
        res
          .status(409)
          .json({
            error:
              "거래 준비 중 지갑 잔액이 바뀌어 예약 자금을 보호할 수 없습니다. 다시 계산해 주세요.",
          });
        return;
      }
    }
    if (planning)
      prepared.warnings = [
        ...prepared.warnings,
        "원래 계획의 왕복 비용은 사용자 가정이며 이번 거래의 실제 견적과 다를 수 있습니다. 미래 회수 비용은 미확정입니다. 이 미리보기는 선택한 USDT 거래 한 건만 준비합니다.",
      ];
    res.json(prepared);
  });
  app.get("/api/transactions/:txid", async (req, res) => {
    res.json(await api.getTransactionStatus(txidSchema.parse(req.params.txid)));
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
  });

  if (production) {
    const distPath = options.distPath ?? path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath, { index: false, dotfiles: "deny" }));
    app.get(/.*/, (_req, res, next) => {
      res.sendFile(path.join(distPath, "index.html"), (error) => {
        if (error) next(error);
      });
    });
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || "request");
      res
        .status(400)
        .json({ error: `입력 형식을 확인해 주세요: ${issues.join(", ")}` });
      return;
    }
    if (error instanceof IntentServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      res.status(413).json({ error: "요청 본문이 너무 큽니다." });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.parse.failed"
    ) {
      res.status(400).json({ error: "올바른 JSON 요청이 필요합니다." });
      return;
    }
    // ChainError messages are intentionally safe, local messages, not upstream responses.
    if (error instanceof Error && error.name === "ChainError") {
      res.status(422).json({ error: error.message });
      return;
    }
    // Never send exception stacks, headers, upstream bodies, API keys or wallet records to clients/logs.
    res
      .status(502)
      .json({
        error:
          "외부 데이터 또는 거래 준비를 확인하지 못했습니다. 실시간 데이터 대신 데모를 적용하지 않았습니다. 잠시 후 다시 시도해 주세요.",
      });
  };
  app.use(errors);
  return app;
}
