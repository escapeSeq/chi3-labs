import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const labs = {
  physics: "http://127.0.0.1:8084/",
  analog: "http://127.0.0.1:8091/",
  handwriting: "http://127.0.0.1:8092/",
  dogfight: "http://127.0.0.1:8093/",
  swarm: "http://127.0.0.1:8094/",
  waves: "http://127.0.0.1:8096/",
};

async function ready(page) {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, type: "png", captureBeyondViewport: false });
  console.log("wrote", file);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--hide-scrollbars", "--disable-gpu"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await mkdir(outDir, { recursive: true });

await page.goto(labs.physics, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
const kerr = await page.$('[data-preset="mixer"]');
if (kerr) await kerr.click();
await page.waitForSelector("#transfer");
await new Promise((r) => setTimeout(r, 1800));
await shot(page, "physics");

await page.goto(labs.analog, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
const run = await page.$("#run");
if (run) await run.click();
await new Promise((r) => setTimeout(r, 3500));
await shot(page, "analog");

await page.goto(labs.handwriting, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
const train = await page.$("#train");
if (train) {
  await train.click();
  await new Promise((r) => setTimeout(r, 4500));
}
await shot(page, "handwriting");

await page.goto(labs.dogfight, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
await page.waitForSelector("#field");
await new Promise((r) => setTimeout(r, 2800));
await shot(page, "dogfight");

await page.goto(labs.swarm, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
await page.waitForSelector("#field");
await new Promise((r) => setTimeout(r, 2800));
await shot(page, "swarm");

await page.goto(labs.waves, { waitUntil: "domcontentloaded", timeout: 30000 });
await ready(page);
await page.waitForSelector("#viewport");
await page.evaluate(() => {
  document.querySelector("#app")?.classList.remove("wave-open", "ship-open");
  document.querySelector("#btn-wave-dock")?.classList.remove("active");
  document.querySelector("#btn-ship-dock")?.classList.remove("active");
});
await new Promise((r) => setTimeout(r, 2500));
await shot(page, "waves");

await browser.close();
console.log("done");
