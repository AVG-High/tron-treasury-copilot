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
let scene = 0;
const pause = async () => {
  const display = await page.evaluate(() => ({
    text:
      document.body.innerText +
      Array.from(document.querySelectorAll("input, textarea"))
        .map((input) => input.value)
        .join(" "),
    overflow: document.documentElement.scrollWidth > innerWidth,
    language: document.documentElement.lang,
  }));
  if (display.language !== "en" || /[가-힣]/u.test(display.text))
    throw new Error("The English demo still contains Korean display text.");
  if (display.overflow)
    throw new Error("The English demo has horizontal overflow.");
  await page.screenshot({
    path: path.join(output, `english-scene-${++scene}.png`),
  });
  await page.waitForTimeout(4500); // Reading time for the silent recording.
};
try {
  await page.goto(base.href);
  await page.evaluate(() => {
    const disclosure = document.createElement("div");
    disclosure.textContent =
      "DEMO · Sample data · AI and real transactions not verified";
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
    .getByRole("heading", { name: "Your money, ready when you need it." })
    .waitFor();
  await pause();
  await page
    .getByRole("button", { name: "Reserve expenses first", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await page
    .getByRole("heading", { name: "Capital allocation", exact: true })
    .waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page
    .getByRole("button", { name: "Extra expense +3,000", exact: true })
    .click();
  await page.getByText("Simulated scenario", { exact: true }).waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page
    .getByRole("button", { name: "Original conditions", exact: true })
    .click();
  // Wait for the recalculation to finish before saving the restored plan.
  await page
    .getByText("Simulated scenario", { exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  await page
    .getByRole("button", { name: "Positions and review", exact: true })
    .click();
  await page.locator(".review-simulation").scrollIntoViewIfNeeded();
  await pause();
  await page.getByLabel("Review rate multiplier").fill("1");
  await page.getByLabel("Review cost multiplier").fill("1");
  await pause();
  await page
    .getByRole("button", { name: "Treasury plan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Short-term cost check", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm and compare" }).click();
  await page
    .getByRole("heading", { name: "Capital allocation", exact: true })
    .waitFor();
  await page.locator(".results-card").scrollIntoViewIfNeeded();
  await pause();
  await page
    .getByRole("button", { name: "Reserve expenses first", exact: true })
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
