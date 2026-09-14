import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "docs", "screenshots");
const baseUrl = process.env.WAVE_RIDER_URL ?? "http://localhost:8080";
const freshUrl = baseUrl.replace(/[#?].*$/, "");

async function waitForCanvas(page) {
  await page.waitForSelector("#viewport");
  await page.waitForTimeout(1200);
}

async function openFresh(page) {
  await page.goto(freshUrl, { waitUntil: "networkidle" });
  await waitForCanvas(page);
}

async function closePanels(page) {
  await page.evaluate(() => {
    document.querySelector("#app")?.classList.remove("wave-open", "ship-open");
    document.querySelector("#btn-wave-dock")?.classList.remove("active");
    document.querySelector("#btn-ship-dock")?.classList.remove("active");
  });
  await page.waitForTimeout(400);
}

async function openWavePanel(page) {
  await page.evaluate(() => {
    document.querySelector("#app")?.classList.add("wave-open");
    document.querySelector("#btn-wave-dock")?.classList.add("active");
  });
  await page.waitForTimeout(350);
}

async function openShipPanel(page) {
  await page.evaluate(() => {
    document.querySelector("#app")?.classList.add("ship-open");
    document.querySelector("#btn-ship-dock")?.classList.add("active");
  });
  await page.waitForTimeout(350);
}

async function clickInDock(page, selector) {
  await page.locator(selector).click({ force: true });
}

async function addWavePreset(page, label) {
  await openWavePanel(page);
  await clickInDock(page, `#form-starters button:text("${label}")`);
  await clickInDock(page, "#btn-add-wave");
  await page.waitForTimeout(600);
}

async function selectShipPreset(page, label) {
  await openShipPanel(page);
  await clickInDock(page, `#ship-presets button:text("${label}")`);
  await page.waitForTimeout(500);
}

async function capture(page, name, options = {}) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, type: "png", ...options });
  console.log("wrote", file);
}

const browser = await chromium.launch(
  process.env.WAVE_RIDER_BROWSER ? { channel: process.env.WAVE_RIDER_BROWSER } : {}
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

await mkdir(outDir, { recursive: true });
await openFresh(page);

// Scene 1: calm glass sea, yacht, panels closed
await addWavePreset(page, "Glass");
await selectShipPreset(page, "Yacht");
await closePanels(page);
await page.waitForTimeout(1500);
await capture(page, "hero-calm");

// Scene 2: swell — main demo shot
await openFresh(page);
await addWavePreset(page, "Swell");
await selectShipPreset(page, "Yacht");
await page.evaluate(() => {
  const speed = document.querySelector("#speed");
  if (speed) {
    speed.value = "10.7";
    speed.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await closePanels(page);
await page.waitForTimeout(2000);
await capture(page, "swell-yacht");

await page.locator("#btn-view").click();
await page.waitForSelector("#app.view-3d");
await page.waitForTimeout(2200);
await capture(page, "swell-yacht-3d");

// Scene 3: storm + racer
await openFresh(page);
await addWavePreset(page, "Storm");
await selectShipPreset(page, "Racer");
await page.evaluate(() => {
  const speed = document.querySelector("#speed");
  if (speed) {
    speed.value = "17.5";
    speed.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await closePanels(page);
await page.waitForTimeout(2200);
await capture(page, "storm-racer");

// Scene 4: wave controls panel
await openFresh(page);
await addWavePreset(page, "Chop");
await addWavePreset(page, "Swell");
await openWavePanel(page);
await page.waitForTimeout(800);
await capture(page, "wave-panel");

// Scene 5: ship controls + motion readouts
await openShipPanel(page);
await selectShipPreset(page, "Trawler");
await page.waitForTimeout(1200);
await capture(page, "ship-panel");

// Scene 6: mobile layout
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
});
const mobilePage = await mobile.newPage();
await openFresh(mobilePage);
await addWavePreset(mobilePage, "Swell");
await closePanels(mobilePage);
await mobilePage.waitForTimeout(1800);
await capture(mobilePage, "mobile-swell", { fullPage: false });

await browser.close();
console.log("Done.");
