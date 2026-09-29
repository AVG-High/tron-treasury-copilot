import { chromium } from "@playwright/test";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "submission");
const base = new URL(process.env.DEMO_BASE_URL || "http://127.0.0.1:4177");
if (
  base.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(base.hostname)
)
  throw new Error("Record only this project's local preview.");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const pause = () => page.waitForTimeout(4500); // Deliberate reading time in the submitted silent screen recording.
try {
  await page.goto(base.href);
  await page.evaluate(() => {
    const disclosure = document.createElement("div");
    disclosure.textContent = "DEMO · 예시 데이터 · AI 응답/실거래 미검증";
    Object.assign(disclosure.style, {
      position: "fixed",
      right: "16px",
      top: "10px",
      zIndex: "9999",
      background: "#49351e",
      color: "#fff1d4",
      padding: "8px 12px",
      border: "1px solid #9a783f",
      borderRadius: "5px",
      fontSize: "13px",
      pointerEvents: "none",
    });
    document.body.append(disclosure);
  });
  await page
    .getByRole("heading", { name: "돈이 필요할 때, 준비된 자금." })
    .waitFor();
  await pause();
  await page
    .getByRole("button", { name: "지출 먼저 확보", exact: true })
    .click();
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  await page.getByRole("heading", { name: "자금 배분", exact: true }).waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page
    .getByRole("button", { name: "추가 지출 +3,000", exact: true })
    .click();
  await page.getByText("가상 시나리오", { exact: true }).waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page.getByRole("button", { name: "원래 조건", exact: true }).click();
  await page.getByRole("button", { name: "계획 저장", exact: true }).click();
  await page.getByRole("button", { name: "포지션·회고", exact: true }).click();
  await page.locator(".review-simulation").scrollIntoViewIfNeeded();
  await pause();
  await page.getByLabel("회고 금리 비율").fill("1");
  await page.getByLabel("회고 비용 비율").fill("1");
  await pause();
  await page.getByRole("button", { name: "자금 계획", exact: true }).click();
  await page
    .getByRole("button", { name: "단기 운용 비용 비교", exact: true })
    .click();
  await page.getByRole("button", { name: "조건 확인하고 비교" }).click();
  await page.getByRole("heading", { name: "자금 배분", exact: true }).waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page
    .getByRole("button", { name: "지출 먼저 확보", exact: true })
    .click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause();
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  const video = page.video();
  await context.close();
  await rename(await video.path(), path.join(output, "treasury-demo.webm"));
  console.log(
    "Saved artifacts/submission/treasury-demo.webm (silent, real UI, DEMO data; no AI or wallet execution).",
  );
} finally {
  await browser.close();
}
