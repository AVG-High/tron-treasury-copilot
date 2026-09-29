import { test, expect, type Page } from "@playwright/test";
import { planTreasury } from "../src/domain/planner";
import {
  defaultIntent,
  defaultCosts,
  demoSnapshot,
} from "../src/domain/fixtures";
import { MAINNET_GENESIS_BLOCK_ID, REGISTRY } from "../src/chain/registry";
import type { MarketSnapshot } from "../src/domain/types";
import { toSavedPlan } from "../src/client/history";

function scenario() {
  const original = planTreasury(
    { ...defaultIntent, maxUSDDExposurePct: 0 },
    structuredClone(demoSnapshot),
    defaultCosts,
  );
  const created = new Date(Date.now() - 8 * 86400000).toISOString();
  original.createdAt = created;
  original.snapshot = structuredClone(original.snapshot);
  original.snapshot.mode = "live";
  original.snapshot.fetchedAt = created;
  original.snapshot.markets.forEach((m) => {
    m.quality = "verified";
    m.evidence.forEach((e) => {
      e.fetchedAt = created;
    });
  });
  const latest = (): MarketSnapshot => {
    const snapshot = structuredClone(original.snapshot);
    snapshot.fetchedAt = new Date().toISOString();
    snapshot.markets.forEach((m) => {
      m.baseApy = "0.001";
      m.cashUSDT = "1";
      m.evidence.forEach((e) => {
        e.fetchedAt = snapshot.fetchedAt;
      });
    });
    return snapshot;
  };
  return { original, latest };
}
async function mockWallet(page: Page) {
  await page.addInitScript(
    ({ owner, genesis }) => {
      (window as any).tronLink = { request: async () => ({ code: 200 }) };
      (window as any).tronWeb = {
        defaultAddress: { base58: owner },
        trx: {
          getBlock: async () => ({ blockID: genesis }),
          sign: () => {
            throw new Error("Monitoring must never sign");
          },
        },
      };
    },
    { owner: REGISTRY.usdt, genesis: MAINNET_GENESIS_BLOCK_ID },
  );
  let reads = 0;
  await page.route("**/api/wallet/*", (route) => {
    reads++;
    return route.fulfill({
      json: {
        address: REGISTRY.usdt,
        network: "tron-mainnet",
        usdt: "4000",
        usdd: "0",
        trx: "10",
        energyRemaining: 0,
        bandwidthRemaining: 0,
        positions: [
          {
            marketId: "justlend-usdt",
            underlyingAsset: "USDT",
            underlyingAmount: `100.00000${reads}`,
            jTokenBalanceRaw: "100000000",
            collateral: false,
          },
        ],
        hasBorrow: false,
        fetchedAt: new Date(
          Date.now() - Math.max(0, 5 - reads) * 1000,
        ).toISOString(),
        warnings: [],
      },
    });
  });
}

test("live observation flags reserve and exit risks, keeps balance changes distinct from earnings, and stages reviewed conditions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { original, latest } = scenario();
  await mockWallet(page);
  await page.route("**/api/plan", (r) => r.fulfill({ json: original }));
  await page.route("**/api/markets?mode=live", (r) =>
    r.fulfill({ json: latest() }),
  );
  let transactionRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/transactions")) transactionRequests++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "실시간", exact: true }).click();
  await page.getByRole("button", { name: "지갑 연결", exact: true }).click();
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  await page.getByRole("button", { name: "포지션·회고", exact: true }).click();
  const panel = page.getByRole("region", { name: "실시간 계획 관측" });
  await expect(
    panel.getByLabel("자동 조회", { exact: true }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "지금 관측" }).click();
  await expect(panel.getByText(/504\.000000 USDT 적습니다/)).toBeVisible();
  await expect(
    panel.getByText(/시장 현금이 현재 보유 포지션 수량보다 적습니다/),
  ).toBeVisible();
  await expect(panel.getByText(/지급 예정일이 도래했습니다/)).toBeVisible();
  await expect(panel.getByText(/계획 경과 8일 \/ 잔여 22일/)).toBeVisible();
  await expect(panel.getByRole("table")).toContainText("JustLend USDT");
  await panel.getByLabel("자동 조회 주기").selectOption("60000");
  await panel.getByRole("button", { name: "지금 관측" }).click();
  await expect(
    panel.getByText("USDT 포지션 평가액 변화", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByText(/실제 순수익: 산출 불가/)).toBeVisible();
  const journal = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("tron-treasury-copilot-observations-v1")!),
  );
  expect(journal.wallets).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/screenshots/monitoring-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await panel.getByRole("button", { name: "남은 기간 조건 검토" }).click();
  await expect(page.getByLabel("총 계획 자금", { exact: true })).toHaveValue(
    "10000",
  );
  await expect(
    page.getByRole("button", { name: "계획 저장", exact: true }),
  ).toHaveCount(0);
  expect(transactionRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("turning polling off discards an in-flight response and never recreates the report", async ({
  page,
}) => {
  const { original, latest } = scenario();
  await page.route("**/api/plan", (r) => r.fulfill({ json: original }));
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/markets?mode=live", async (route) => {
    if (++count > 1) await gate;
    await route.fulfill({ json: latest() }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "실시간", exact: true }).click();
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  await page.getByRole("button", { name: "포지션·회고", exact: true }).click();
  const panel = page.getByRole("region", { name: "실시간 계획 관측" });
  const requested = page.waitForRequest((r) =>
    r.url().endsWith("/api/markets?mode=live"),
  );
  await panel.getByLabel("자동 조회", { exact: true }).check();
  await requested;
  await panel.getByLabel("자동 조회", { exact: true }).uncheck();
  release();
  await expect(panel.getByRole("button", { name: "지금 관측" })).toBeEnabled();
  await expect(panel.getByText(/최근 관측/)).toHaveCount(0);
  await page.getByRole("button", { name: "자금 계획", exact: true }).click();
  await page.getByLabel("비상금", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "포지션·회고", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByText(/계획 변화 관측은 실시간 모드에서 조건을 확인/),
  ).toBeVisible();
});

test("restoring an expired plan retains liabilities and requires a new horizon", async ({
  page,
}) => {
  const original = planTreasury(
    defaultIntent,
    structuredClone(demoSnapshot),
    defaultCosts,
  );
  original.createdAt = new Date(Date.now() - 31 * 86400000).toISOString();
  const saved = toSavedPlan(
    original,
    original.plans.find((p) => p.id === "yield")!,
  );
  await page.addInitScript(
    (savedPlan) =>
      localStorage.setItem(
        "tron-treasury-copilot-history-v1",
        JSON.stringify({ version: 1, plans: [savedPlan], transactions: [] }),
      ),
    saved,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "포지션·회고", exact: true }).click();
  await page
    .getByRole("button", { name: "조건 불러오기", exact: true })
    .click();
  await expect(
    page.getByLabel("남는 돈 운용 기간", { exact: true }),
  ).toHaveValue("0");
  await expect(page.getByText(/원래 운용 기간이 끝났습니다/)).toBeVisible();
  const rejected = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  expect((await rejected).status()).toBe(400);
  await page.getByLabel("남는 돈 운용 기간", { exact: true }).fill("30");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  const calculated = await (await response).json();
  expect(calculated.reserveUSDT).toBe("4500.000000");
  expect(
    calculated.intent.expenses.every(
      (e: { dueInDays: number }) => e.dueInDays === 0,
    ),
  ).toBe(true);
});
