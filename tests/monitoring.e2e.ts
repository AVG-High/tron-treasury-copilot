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
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Live plan monitoring" });
  await expect(
    panel.getByLabel("Auto-refresh", { exact: true }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "Check now" }).click();
  await expect(panel.getByText(/504\.000000 USDT 적습니다/)).toBeVisible();
  await expect(
    panel.getByText(/시장 현금이 현재 보유 포지션 수량보다 적습니다/),
  ).toBeVisible();
  await expect(panel.getByText(/지급 예정일이 도래했습니다/)).toBeVisible();
  await expect(
    panel.getByText(/Elapsed 8 days \/ Remaining 22 days/),
  ).toBeVisible();
  await expect(panel.getByRole("table")).toContainText("JustLend USDT");
  await panel.getByLabel("Auto-refresh interval").selectOption("60000");
  await panel.getByRole("button", { name: "Check now" }).click();
  await expect(
    panel.getByText("USDT position value change", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByText(/Actual net profit: unavailable/)).toBeVisible();
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
  await panel.getByRole("button", { name: "Review remaining horizon" }).click();
  await expect(
    page.getByLabel("Total planned capital", { exact: true }),
  ).toHaveValue("10000");
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
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
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Live plan monitoring" });
  const requested = page.waitForRequest((r) =>
    r.url().endsWith("/api/markets?mode=live"),
  );
  await panel.getByLabel("Auto-refresh", { exact: true }).check();
  await requested;
  await panel.getByLabel("Auto-refresh", { exact: true }).uncheck();
  release();
  await expect(panel.getByRole("button", { name: "Check now" })).toBeEnabled();
  await expect(panel.getByText(/Last observation/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Treasury plan", exact: true })
    .click();
  await page.getByLabel("Emergency reserve", { exact: true }).fill("1000");
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByText(/Plan monitoring is available after confirming conditions/),
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
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore conditions", exact: true })
    .click();
  await expect(
    page.getByLabel("Investment horizon", { exact: true }),
  ).toHaveValue("0");
  await expect(page.getByText(/The original horizon has ended/)).toBeVisible();
  const rejected = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  expect((await rejected).status()).toBe(400);
  await page.getByLabel("Investment horizon", { exact: true }).fill("30");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  const calculated = await (await response).json();
  expect(calculated.reserveUSDT).toBe("4500.000000");
  expect(
    calculated.intent.expenses.every(
      (e: { dueInDays: number }) => e.dueInDays === 0,
    ),
  ).toBe(true);
});
