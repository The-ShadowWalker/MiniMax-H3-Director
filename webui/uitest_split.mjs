/**
 * With hand-set (manual) windows, everything that works in windows must use
 * THOSE windows, not the automatic plan: Split, the "crosses a boundary"
 * warning and snapping. Split once cut at the automatic boundaries, so in
 * manual mode it cut in the wrong places, or not at all.
 *
 *     cd webui && node uitest_split.mjs
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "..", "assets", "index.html");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIPPED: playwright not installed"); process.exit(0); }
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"].find((p) => existsSync(p));
if (!existsSync(PAGE)) { console.log("SKIPPED: assets/index.html not built yet"); process.exit(0); }

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + PAGE);
await page.waitForTimeout(2000);

const bands = () => page.$$eval(".winstrip .band", (e) => e.map((x) => ({
  left: x.getBoundingClientRect().left, right: x.getBoundingClientRect().right, frames: Number(x.dataset.frames) })));
const videoSegs = () => page.$$eval('.trk[data-track="video"] .seg-c', (e) => e.map((x) => ({
  left: x.getBoundingClientRect().left, right: x.getBoundingClientRect().right, text: x.innerText })));

// manual mode, then make the windows uneven by dragging the first boundary
await page.evaluate(() => {
  [...document.querySelectorAll("label.chk")].find((l) => l.textContent.trim().toLowerCase() === "manual")
    .querySelector("input").click();
});
await page.waitForTimeout(400);
const h = await page.$(".whandle.tall");
const b = await h.boundingBox();
await page.mouse.move(b.x + b.width / 2, b.y + 20);
await page.mouse.down();
await page.mouse.move(b.x + b.width / 2 - 140, b.y + 20, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(400);
const wb = await bands();
check("in manual mode the first window was made shorter", wb[0].frames < 300, JSON.stringify(wb.map((x) => x.frames)));

// the first prompt now runs past the moved boundary
const before = await videoSegs();
await page.mouse.click(before[0].left + 60, (await (await page.$('.trk[data-track="video"] .seg-c')).boundingBox()).y + 10);
await page.waitForTimeout(300);
const warn = await page.evaluate(() => /crosses a window boundary/i.test(document.body.innerText));
check("the prompt is flagged as crossing the hand-set boundary", warn);
const split = await page.$("button:has-text('Split at window')");
check("and offers to split it", !!split);
if (split) { await split.click(); await page.waitForTimeout(400); }
const after = await videoSegs();
check("Split made one more prompt", after.length === before.length + 1, `${before.length} -> ${after.length}`);
const near = (a, c) => Math.abs(a - c) <= 1.5;
const piece = after.find((x) => near(x.left, wb[1].left));
check("the cut is exactly at the hand-set boundary", !!piece,
  JSON.stringify({ boundary: wb[1].left, starts: after.map((x) => Math.round(x.left)) }));
check("the first piece ends there too", after.some((x) => near(x.left, before[0].left) && near(x.right, wb[1].left)));
check("no uncaught errors", errors.length === 0, errors[0]);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} SPLIT CHECK(S) FAILED`); process.exit(1); }
console.log("ALL SPLIT CHECKS PASSED");
