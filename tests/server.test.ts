import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import {
  createApp,
  allowedOriginsFromEnv,
  type AppOptions,
} from "../src/server/app";
import { parseIntent, isAiConfigured } from "../src/server/intent";
import {
  defaultIntent,
  defaultCosts,
  demoSnapshot,
} from "../src/domain/fixtures";
import type {
  MarketSnapshot,
  WalletState,
  TransactionPreview,
} from "../src/domain/types";

const origin = "http://127.0.0.1:4177";
const owner = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(options: AppOptions = {}) {
  const app = createApp({ allowedOrigins: [origin], ...options });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve(listening);
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  const base = `http://127.0.0.1:${address.port}`;
  return (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const options = {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    if (headers.Host)
      return new Promise<Response>((resolve, reject) => {
        // Native fetch normalizes Host. A raw HTTP request actually exercises the rebinding boundary.
        const call = httpRequest(base + route, options, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks).toString(), {
                status: response.statusCode,
              }),
            ),
          );
        });
        call.on("error", reject);
        call.end(options.body);
      });
    return fetch(base + route, options);
  };
}

const liveSnapshot = (): MarketSnapshot => ({
  ...structuredClone(demoSnapshot),
  mode: "live",
  fetchedAt: new Date().toISOString(),
  markets: demoSnapshot.markets.map((market) => ({
    ...structuredClone(market),
    quality: "verified",
    evidence: market.evidence.map((evidence) => ({
      ...evidence,
      fetchedAt: new Date().toISOString(),
    })),
  })),
});
const wallet = (usdt = "10000"): WalletState => ({
  address: owner,
  network: "tron-mainnet",
  usdt,
  usdd: "0",
  trx: "30",
  energyRemaining: 100000,
  bandwidthRemaining: 1000,
  positions: [],
  hasBorrow: false,
  fetchedAt: new Date().toISOString(),
  warnings: [],
});
const preview: TransactionPreview = {
  action: "supply-usdt",
  owner,
  to: owner,
  spender: null,
  amount: "100",
  asset: "USDT",
  functionSelector: "mint(uint256)",
  parameters: [],
  feeLimitSun: 100000000,
  estimatedEnergy: 100,
  estimatedFeeTRX: "1",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  warnings: [],
  unsignedTransaction: {},
  digest: "test",
};

describe("API boundary", () => {
  it("health exposes configuration only, not secrets", async () => {
    vi.stubEnv("OPENAI_API_KEY", "secret-test-value");
    const request = await serve({ aiConfigured: false });
    const response = await request("/api/health");
    const data = await response.json();
    expect(data.aiConfigured).toBe(false);
    expect(JSON.stringify(data)).not.toContain("secret-test-value");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves fixtures only when demo is explicitly selected", async () => {
    const live = vi.fn().mockResolvedValue(liveSnapshot());
    const request = await serve({ services: { getLiveSnapshot: live } });
    expect((await (await request("/api/markets?mode=demo")).json()).mode).toBe(
      "demo",
    );
    expect(live).not.toHaveBeenCalled();
    expect((await (await request("/api/markets")).json()).mode).toBe("live");
    await request("/api/markets?mode=live");
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("returns a failure without fallback or upstream secrets, then retries a failed live read", async () => {
    const live = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret-token-upstream-body"))
      .mockResolvedValue(liveSnapshot());
    const request = await serve({ services: { getLiveSnapshot: live } });
    const failed = await request("/api/markets");
    expect(failed.status).toBe(502);
    const message = await failed.text();
    expect(message).not.toContain("secret-token-upstream-body");
    expect(message).not.toContain('"mode":"demo"');
    expect((await request("/api/markets")).status).toBe(200);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin and missing-origin mutations", async () => {
    const parser = vi.fn();
    const request = await serve({ services: { parseIntent: parser } });
    expect(
      (
        await request(
          "/api/intent",
          { text: "hello" },
          { Origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/intent", { text: "hello" }, { Origin: "" })).status,
    ).toBe(403);
    expect(parser).not.toHaveBeenCalled();
  });

  it("rejects unsupported modes, excessive text and invalid transaction fields before adapters", async () => {
    const prepare = vi.fn();
    const request = await serve({ services: { prepareTransaction: prepare } });
    expect((await request("/api/markets?mode=unknown")).status).toBe(400);
    expect(
      (await request("/api/intent", { text: "a".repeat(6001) })).status,
    ).toBe(400);
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "approve-usdt",
          owner,
          amount: "1",
          to: "attacker",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "supply-usdt",
          owner,
          amount: "0",
        })
      ).status,
    ).toBe(400);
    expect((await request("/api/wallet/not-an-address")).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("validates financial strings and keeps infeasible plans distinct from malformed input", async () => {
    const request = await serve();
    const valid = { intent: defaultIntent, costs: defaultCosts, mode: "demo" };
    const response = await request("/api/plan", valid);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(Number(data.reserveUSDT)).toBe(4500);
    expect(data.snapshot.mode).toBe("demo");
    const infeasible = await request("/api/plan", {
      ...valid,
      intent: { ...defaultIntent, capitalUSDT: "100" },
    });
    expect(infeasible.status).toBe(200);
    expect((await infeasible.json()).feasible).toBe(false);
    expect(
      (
        await request("/api/plan", {
          ...valid,
          intent: { ...defaultIntent, capitalUSDT: "1e9" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/plan", {
          ...valid,
          intent: { ...defaultIntent, capitalUSDT: 10000 },
        })
      ).status,
    ).toBe(400);
  });

  it("enforces an intent request limit and a JSON size limit", async () => {
    const parser = vi
      .fn()
      .mockResolvedValue({
        source: "manual",
        intent: {},
        questions: [],
        message: "manual",
      });
    const request = await serve({
      intentRateLimit: 1,
      services: { parseIntent: parser },
    });
    expect((await request("/api/intent", { text: "hello" })).status).toBe(200);
    expect((await request("/api/intent", { text: "again" })).status).toBe(429);
    const second = await serve();
    expect(
      (await second("/api/intent", { text: "a".repeat(35000) })).status,
    ).toBe(413);
  });

  it("does not bypass the paid intent limit with route casing, slashes or forwarded IPs", async () => {
    const parser = vi
      .fn()
      .mockResolvedValue({
        source: "manual",
        intent: {},
        questions: [],
        message: "manual",
      });
    const request = await serve({
      intentRateLimit: 1,
      services: { parseIntent: parser },
    });
    expect((await request("/api/intent", { text: "hello" })).status).toBe(200);
    expect(
      (
        await request(
          "/api/INTENT/",
          { text: "again" },
          { "X-Forwarded-For": "203.0.113.10" },
        )
      ).status,
    ).toBe(429);
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it("rejects untrusted Host headers even if forwarded headers claim the trusted host", async () => {
    const request = await serve();
    expect(
      (
        await request("/api/health", undefined, {
          Host: "attacker.invalid",
          "X-Forwarded-Host": "127.0.0.1",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/intent",
          { text: "hello" },
          { Origin: "http://127.0.0.1.attacker.invalid:4177" },
        )
      ).status,
    ).toBe(403);
  });

  it("does not expose arbitrary broadcast or signing APIs", async () => {
    const request = await serve();
    expect((await request("/api/transactions/broadcast", {})).status).toBe(404);
    expect((await request("/api/sign", {})).status).toBe(404);
  });

  it("requires live confirmed planning for supply and protects the expense reserve", async () => {
    const prepare = vi.fn().mockResolvedValue(preview);
    const live = vi.fn().mockResolvedValue(liveSnapshot());
    const getWallet = vi.fn().mockResolvedValue(wallet("4000"));
    const request = await serve({
      services: {
        prepareTransaction: prepare,
        getLiveSnapshot: live,
        getWalletState: getWallet,
      },
    });
    const transaction = { action: "supply-usdt", owner, amount: "100" };
    expect(
      (await request("/api/transactions/prepare", transaction)).status,
    ).toBe(400);
    const planning = {
      mode: "live",
      planId: "yield",
      intent: defaultIntent,
      costs: defaultCosts,
    };
    expect(
      (
        await request("/api/transactions/prepare", {
          ...transaction,
          planning: { ...planning, mode: "demo" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/transactions/prepare", { ...transaction, planning }))
        .status,
    ).toBe(409);
    expect(prepare).not.toHaveBeenCalled();
    getWallet.mockResolvedValue(wallet());
    expect(
      (await request("/api/transactions/prepare", { ...transaction, planning }))
        .status,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith(transaction);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("rejects supply beyond the selected plan and client-forged estimate provenance", async () => {
    const prepare = vi.fn();
    const request = await serve({
      services: {
        prepareTransaction: prepare,
        getLiveSnapshot: vi.fn().mockResolvedValue(liveSnapshot()),
        getWalletState: vi.fn().mockResolvedValue(wallet()),
      },
    });
    const planning = {
      mode: "live",
      planId: "yield",
      intent: defaultIntent,
      costs: defaultCosts,
    };
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "supply-usdt",
          owner,
          amount: "9999",
          planning,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "supply-usdt",
          owner,
          amount: "100",
          planning: {
            ...planning,
            costs: { ...defaultCosts, source: "wallet-estimate" },
          },
        })
      ).status,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("allows an exact zero allowance reset without requiring a new investment plan", async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue({ ...preview, action: "approve-usdt", amount: "0" });
    const request = await serve({ services: { prepareTransaction: prepare } });
    const input = { action: "approve-usdt", owner, amount: "0" };
    expect((await request("/api/transactions/prepare", input)).status).toBe(
      200,
    );
    expect(prepare).toHaveBeenCalledWith(input);
  });

  it("does not approve more than the selected allocation when a plan is attached", async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue({ ...preview, action: "approve-usdt" });
    const request = await serve({
      services: {
        prepareTransaction: prepare,
        getLiveSnapshot: vi.fn().mockResolvedValue(liveSnapshot()),
        getWalletState: vi.fn().mockResolvedValue(wallet()),
      },
    });
    const planning = {
      mode: "live",
      planId: "yield",
      intent: defaultIntent,
      costs: defaultCosts,
    };
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "approve-usdt",
          owner,
          amount: "9999",
          planning,
        })
      ).status,
    ).toBe(409);
    expect(prepare).not.toHaveBeenCalled();
    expect(
      (
        await request("/api/transactions/prepare", {
          action: "approve-usdt",
          owner,
          amount: "100",
          planning,
        })
      ).status,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith({
      action: "approve-usdt",
      owner,
      amount: "100",
    });
  });

  it("rejects an externally reduced wallet balance observed after transaction construction", async () => {
    const prepare = vi.fn().mockResolvedValue({ ...preview });
    const getWallet = vi
      .fn()
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet("4550"));
    const request = await serve({
      services: {
        prepareTransaction: prepare,
        getLiveSnapshot: vi.fn().mockResolvedValue(liveSnapshot()),
        getWalletState: getWallet,
      },
    });
    const planning = {
      mode: "live",
      planId: "yield",
      intent: defaultIntent,
      costs: defaultCosts,
    };
    const response = await request("/api/transactions/prepare", {
      action: "supply-usdt",
      owner,
      amount: "100",
      planning,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("준비 중");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(getWallet).toHaveBeenCalledTimes(2);
  });
});

const extracted = {
  capitalUSDT: "10000",
  horizonDays: null,
  emergencyUSDT: null,
  expenses: null,
  maxUSDDExposurePct: null,
  maxProtocolExposurePct: null,
  allowVolatile: null,
  allowLeverage: false,
  questions: [],
};
const aiResponse = (value: unknown, status = "completed") =>
  new Response(
    JSON.stringify({
      status,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
    { status: 200 },
  );

describe("natural-language intent extraction", () => {
  it("does not pretend to parse without both explicit model and key", async () => {
    const transport = vi.fn();
    const result = await parseIntent("10,000 USDT and 3000 next week", {
      apiKey: "",
      model: "",
      fetch: transport,
    });
    expect(result.source).toBe("manual");
    expect(result.intent).toEqual({});
    expect(result.questions.length).toBeGreaterThan(0);
    expect(transport).not.toHaveBeenCalled();
    expect(isAiConfigured({ apiKey: "key", model: "" })).toBe(false);
  });

  it("keeps unstated conditions missing and asks about the residual investment horizon", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        aiResponse({
          ...extracted,
          expenses: [{ label: "Payment", amountUSDT: "3000", dueInDays: 7 }],
        }),
      );
    const result = await parseIntent(
      "I have 10000 USDT and need 3000 USDT in seven days. No leverage.",
      { apiKey: "test", model: "configured-test-model", fetch: transport },
    );
    expect(result.source).toBe("ai");
    expect(result.intent.horizonDays).toBeUndefined();
    expect(result.intent.emergencyUSDT).toBeUndefined();
    expect(result.intent.maxUSDDExposurePct).toBeUndefined();
    expect(result.intent.expenses?.[0].dueInDays).toBe(7);
    expect(
      result.questions.some((question) => question.includes("남는 자금")),
    ).toBe(true);
    const request = JSON.parse(transport.mock.calls[0][1].body);
    expect(request.store).toBe(false);
    expect(request.text.format.strict).toBe(true);
    expect(request.model).toBe("configured-test-model");
    expect(request.tools).toBeUndefined();
  });

  it("does not change missing expenses into no expenses or unsupported leverage into consent", async () => {
    const result = await parseIntent("Use leverage", {
      apiKey: "test",
      model: "model",
      fetch: vi
        .fn()
        .mockResolvedValue(aiResponse({ ...extracted, allowLeverage: true })),
    });
    expect(result.intent.expenses).toBeUndefined();
    expect(result.intent.allowLeverage).toBeUndefined();
    expect(
      result.questions.some((question) => question.includes("레버리지")),
    ).toBe(true);
  });

  it("rejects incomplete, out-of-schema and refused responses without applying them", async () => {
    for (const payload of [
      aiResponse(extracted, "incomplete"),
      aiResponse({ ...extracted, capitalUSDT: "-1000" }),
      aiResponse({ ...extracted, capitalUSDT: "1000000001" }),
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "refusal", refusal: "no" }] },
          ],
        }),
      ),
    ]) {
      await expect(
        parseIntent("text", {
          apiKey: "test",
          model: "model",
          fetch: vi.fn().mockResolvedValue(payload),
        }),
      ).rejects.toThrow("결과를 적용하지 않았습니다");
    }
  });

  it("does not leak provider error bodies or credentials", async () => {
    await expect(
      parseIntent("text", {
        apiKey: "secret",
        model: "model",
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response("secret-sensitive-upstream", { status: 401 }),
          ),
      }),
    ).rejects.toThrow("AI 요청에 실패했습니다");
  });

  it("rejects unsafe public origin configuration", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "http://example.com");
    expect(() => allowedOriginsFromEnv()).toThrow();
    vi.stubEnv("PUBLIC_ORIGIN", "https://example.com/path");
    expect(() => allowedOriginsFromEnv()).toThrow();
    vi.stubEnv("PUBLIC_ORIGIN", "https://example.com");
    expect(allowedOriginsFromEnv()).toEqual(["https://example.com"]);
  });
});
