import { test, expect } from "@playwright/test";
import { REGISTRY } from "../src/chain/registry";

test("quick examples show reserve-first allocation and a genuine hold-only short-horizon result", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Short-term cost check", exact: true })
    .click();
  await expect(
    page.getByLabel("Total planned capital", { exact: true }),
  ).toHaveValue("2000");
  await expect(
    page.getByLabel("Investment horizon", { exact: true }),
  ).toHaveValue("7");
  const shortResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  const short = await (await shortResponse).json();
  expect(short.snapshot.mode).toBe("demo");
  expect(short.plans.map((p: { id: string }) => p.id)).toEqual(["hold"]);
  await page
    .getByRole("button", { name: "Reserve expenses first", exact: true })
    .click();
  const reserveResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  const reserve = await (await reserveResponse).json();
  expect(reserve.reserveUSDT).toBe("4500.000000");
  expect(reserve.plans.length).toBe(3);
});

test("AI omissions need explicit confirmation and any edited conditions invalidate that confirmation", async ({
  page,
}) => {
  await page.route("**/api/intent", (route) =>
    route.fulfill({
      json: {
        source: "ai",
        intent: { capitalUSDT: "8000" },
        questions: ["남은 돈은 며칠간 운용하나요?"],
        message: "모의 AI 응답 · 누락 조건 검사",
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Interpret request", exact: true })
    .click();
  const calculate = page.getByRole("button", { name: "Confirm and compare" });
  await expect(calculate).toBeDisabled();
  await expect(page.getByText(/Unconfirmed fields:/)).toBeVisible();
  await expect(
    page.getByLabel("Total planned capital", { exact: true }),
  ).toHaveValue("8000");
  const confirmation = page.getByRole("checkbox", {
    name: /I have reviewed the questions and current inputs/,
  });
  await confirmation.check();
  await expect(calculate).toBeEnabled();
  await page.getByLabel("Emergency reserve", { exact: true }).fill("600");
  await expect(confirmation).not.toBeChecked();
  await expect(calculate).toBeDisabled();
  await confirmation.check();
  await calculate.click();
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Describe your requirements", { exact: true })
    .fill("변경한 자연어 조건");
  await expect(
    page.getByRole("button", { name: "Save plan", exact: true }),
  ).toBeDisabled();
});

test("PSM observation displays unknown separately from zero and never enables a transaction", async ({
  page,
}) => {
  await page.route("**/api/psm-status", (route) =>
    route.fulfill({
      json: {
        quality: "verified",
        fetchedAt: new Date().toISOString(),
        chain: "tron-mainnet",
        usddAddress: REGISTRY.usdd,
        psmAddress: REGISTRY.psmUsdt,
        joinAddress: REGISTRY.psmUsdtJoin,
        sellEnabled: true,
        buyEnabled: false,
        toUSDDFeePct: "0",
        fromUSDDFeePct: "0.2",
        availableUSDT: null,
        evidence: [],
        warnings: ["모의 조회이며 실제 거래를 지원하지 않습니다."],
      },
    }),
  );
  await page.route("**/api/markets?mode=live", (r) =>
    r.fulfill({
      json: {
        mode: "live",
        fetchedAt: new Date().toISOString(),
        markets: [],
        psm: { available: false, warnings: [], evidence: [] },
        warnings: [],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page
    .getByRole("button", { name: "Products and data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check USDD conversion status", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "USDD on-chain conversion status",
  });
  await expect(
    panel.getByText("Contract paused", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Conversion fee 0%", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Conversion fee 0.2%", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(/Current conversion capacity: not calculated/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Sign and submit/ }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
