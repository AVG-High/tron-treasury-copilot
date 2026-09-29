import { test, expect } from "@playwright/test";
import { REGISTRY } from "../src/chain/registry";

test("quick examples show reserve-first allocation and a genuine hold-only short-horizon result", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "단기 운용 비용 비교", exact: true })
    .click();
  await expect(page.getByLabel("총 계획 자금", { exact: true })).toHaveValue(
    "2000",
  );
  await expect(
    page.getByLabel("남는 돈 운용 기간", { exact: true }),
  ).toHaveValue("7");
  const shortResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  const short = await (await shortResponse).json();
  expect(short.snapshot.mode).toBe("demo");
  expect(short.plans.map((p: { id: string }) => p.id)).toEqual(["hold"]);
  await page
    .getByRole("button", { name: "지출 먼저 확보", exact: true })
    .click();
  const reserveResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/plan"),
  );
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
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
  await page.getByRole("button", { name: "조건 해석", exact: true }).click();
  const calculate = page.getByRole("button", { name: "조건 확인하고 비교" });
  await expect(calculate).toBeDisabled();
  await expect(page.getByText(/미확인 항목:/)).toBeVisible();
  await expect(page.getByLabel("총 계획 자금", { exact: true })).toHaveValue(
    "8000",
  );
  const confirmation = page.getByRole("checkbox", {
    name: /질문과 현재 입력값을 검토했고/,
  });
  await confirmation.check();
  await expect(calculate).toBeEnabled();
  await page.getByLabel("비상금", { exact: true }).fill("600");
  await expect(confirmation).not.toBeChecked();
  await expect(calculate).toBeDisabled();
  await confirmation.check();
  await calculate.click();
  await expect(
    page.getByRole("button", { name: "계획 저장", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("자연어 운용 조건", { exact: true })
    .fill("변경한 자연어 조건");
  await expect(
    page.getByRole("button", { name: "계획 저장", exact: true }),
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
  await page.getByRole("button", { name: "실시간", exact: true }).click();
  await page.getByRole("button", { name: "상품·데이터", exact: true }).click();
  await page
    .getByRole("button", { name: "USDD 전환 상태 조회", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "USDD 온체인 전환 관측" });
  await expect(panel.getByText("컨트랙트 중지", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("전환 수수료 0%", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("전환 수수료 0.2%", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/현재 교환 가능액: 산출 미지원/)).toBeVisible();
  await expect(page.getByRole("button", { name: /서명하고 제출/ })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
