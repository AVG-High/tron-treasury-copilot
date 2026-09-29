import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { planTreasury } from "../src/domain/planner";
import {
  defaultIntent,
  defaultCosts,
  demoSnapshot,
} from "../src/domain/fixtures";
import { MAINNET_GENESIS_BLOCK_ID, REGISTRY } from "../src/chain/registry";

test("mocked wallet submission preserves exact preview and links a unique saved plan", async ({
  page,
}) => {
  // All wallet/network actions in this case are explicit test doubles: no keys or chain broadcast.
  const owner = REGISTRY.usdt;
  const rawHex = "0a0101",
    txid = createHash("sha256")
      .update(Buffer.from(rawHex, "hex"))
      .digest("hex");
  const fixture = planTreasury(
    defaultIntent,
    structuredClone(demoSnapshot),
    defaultCosts,
  );
  fixture.snapshot.mode = "live";
  const mockWallet = {
    address: owner,
    network: "tron-mainnet",
    usdt: "10000",
    usdd: null,
    trx: "100",
    energyRemaining: 0,
    bandwidthRemaining: 0,
    positions: [],
    hasBorrow: false,
    fetchedAt: new Date().toISOString(),
    warnings: [],
  };
  await page.addInitScript(
    ({ owner, genesis }) => {
      (window as any).tronLink = { request: async () => ({ code: 200 }) };
      (window as any).tronWeb = {
        defaultAddress: { base58: owner },
        trx: {
          getBlock: async () => ({ blockID: genesis }),
          sign: async (tx: any) => ({ ...tx, signature: ["test-signature"] }),
          sendRawTransaction: async (tx: any) => ({
            result: true,
            txid: tx.txID,
          }),
        },
      };
    },
    { owner, genesis: MAINNET_GENESIS_BLOCK_ID },
  );
  await page.route("**/api/markets?mode=live", (r) =>
    r.fulfill({ json: fixture.snapshot }),
  );
  await page.route("**/api/plan", (r) => r.fulfill({ json: fixture }));
  await page.route("**/api/wallet/*", (r) => r.fulfill({ json: mockWallet }));
  await page.route("**/api/transactions/prepare", async (r) => {
    const body = r.request().postDataJSON();
    expect(body.planning.mode).toBe("live");
    expect(body.planning.planId).toBe("yield");
    await r.fulfill({
      json: {
        action: body.action,
        owner,
        to: REGISTRY.jUsdt,
        spender: null,
        amount: body.amount,
        asset: "USDT",
        functionSelector: "mint(uint256)",
        parameters: [body.amount],
        feeLimitSun: 100000000,
        estimatedEnergy: 10000,
        estimatedFeeTRX: "1",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        warnings: ["TEST DOUBLE"],
        unsignedTransaction: { txID: txid, raw_data_hex: rawHex, raw_data: {} },
        digest: txid,
      },
    });
  });
  await page.route(`**/api/transactions/${txid}`, (r) =>
    r.fulfill({ json: { status: "confirmed", actualFeeTRX: "1" } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await page
    .getByRole("button", { name: "2. Review supply quote", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(owner, { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Sign and submit in TronLink", exact: true })
    .click();
  await expect(
    page.getByText(
      "Transaction submitted. Check its status in the transaction history.",
    ),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("tron-treasury-copilot-history-v1")!),
  );
  expect(stored.transactions).toHaveLength(1);
  const record = stored.transactions[0];
  expect(record.txid).toBe(txid);
  expect(record.planId).not.toBe("yield");
  expect(
    stored.plans.find((p: any) => p.id === record.planId).plan.selectedPlanId,
  ).toBe("yield");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
});

test("confirmed demo plan compares alternatives, preserves reserved cash when dates advance, and saves", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your money, ready when you need it." }),
  ).toBeVisible();
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  const original = await (await responsePromise).json();
  expect(original.feasible).toBe(true);
  expect(original.plans.length).toBe(3);
  expect(original.reserveUSDT).toBe("4500.000000");
  await expect(
    page.getByRole("heading", { name: "Capital allocation" }),
  ).toBeVisible();
  await expect(
    page.getByText("Transactions cannot be prepared or signed in demo mode."),
  ).toBeVisible();
  const advancePromise = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page
    .getByRole("button", { name: "Expense due tomorrow", exact: true })
    .click();
  const advanced = await (await advancePromise).json();
  expect(advanced.plans.map((p: any) => p.allocations)).toEqual(
    original.plans.map((p: any) => p.allocations),
  );
  await expect(
    page.getByText("Simulated scenario", { exact: true }),
  ).toBeVisible();
  const extraPromise = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page
    .getByRole("button", { name: "Extra expense +3,000", exact: true })
    .click();
  const extra = await (await extraPromise).json();
  expect(extra.reserveUSDT).toBe("7500.000000");
  expect(
    Number(extra.plans.find((p: any) => p.id === "yield").investedUSDT),
  ).toBeLessThan(
    Number(original.plans.find((p: any) => p.id === "yield").investedUSDT),
  );
  await page
    .getByRole("button", { name: "Original conditions", exact: true })
    .click();
  await expect(
    page.getByText("Simulated scenario", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  await expect(page.getByText("Demo plan", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Simulated review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("These are not real positions or realized returns.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Review rate multiplier").fill("1");
  await page.getByLabel("Review cost multiplier").fill("1");
  await expect(
    page
      .locator(".replay-results>div")
      .filter({ hasText: "Difference from plan" }),
  ).toContainText("0.00");
  await page.reload();
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  await expect(page.getByText("Demo plan", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Restore conditions", exact: true })
    .click();
  await expect(
    page.getByLabel("Total planned capital", { exact: true }),
  ).toHaveValue("10000");
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unfunded expenses produce infeasible result, never a made-up investable plan", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Total planned capital", { exact: true }).fill("2000");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  const data = await (await response).json();
  expect(data.feasible).toBe(false);
  expect(data.plans).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toHaveCount(0);
});

test("editing confirmed inputs invalidates execution and saving until recomputation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Emergency reserve", { exact: true }).fill("900");
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Conditions changed. Please recalculate."),
  ).toBeVisible();
});

test("live request failure stays live with no silent demo fallback", async ({
  page,
}) => {
  await page.route("**/api/markets?mode=live", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Live 데이터 검증 Failed" }),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Live 데이터 검증 Failed",
  );
  await expect(page.getByText("Live data mode", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
});

test("late calculation response cannot confirm inputs changed while request was pending", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/plan", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");
  const requested = page.waitForRequest((r) => r.url().endsWith("/api/plan"));
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await requested;
  await page.getByLabel("Emergency reserve", { exact: true }).fill("9500");
  release();
  await expect(
    page.getByText(
      "Conditions changed during calculation. Please review the updated inputs.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Emergency reserve", { exact: true }),
  ).toHaveValue("9500");
});

test("no configured AI is honestly manual and preserves editable conditions", async ({
  page,
}) => {
  await page.route("**/api/intent", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        intent: {},
        questions: ["남는 돈을 며칠간 운용하나요?"],
        source: "manual",
        message: "AI 연결이 없어 직접 조건을 입력해 주세요.",
      }),
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Interpret request", exact: true })
    .click();
  await expect(
    page.getByText("AI not connected · manual input", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Total planned capital", { exact: true }),
  ).toHaveValue("10000");
});

test("desktop and mobile visual check; no horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Capital allocation" }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Products and data", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Products and exit conditions" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
