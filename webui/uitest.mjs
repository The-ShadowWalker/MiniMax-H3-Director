/**
 * Browser smoke test for the built UI.
 *
 * The other guards check arithmetic. This one checks the things arithmetic
 * cannot: that the app actually renders, that a control is where a person was
 * told it would be, and that dragging does something. It exists because a
 * release shipped with the manual-window toggle in the wrong panel and
 * boundaries that could not be grabbed -- both invisible to a typecheck.
 *
 * Needs playwright and a chromium build. Skips cleanly (exit 0) when either is
 * missing, so it never blocks a machine that has neither:
 *
 *     cd webui && npm install --no-save playwright && node uitest.mjs
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "..", "assets", "index.html");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIPPED: playwright not installed");
  process.exit(0);
}

// Prefer a preinstalled chromium; fall back to whatever playwright manages.
const CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
];
const executablePath = CANDIDATES.find((p) => existsSync(p));

if (!existsSync(PAGE)) {
  console.log("SKIPPED: assets/index.html not built yet");
  process.exit(0);
}

let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : {});
} catch (e) {
  console.log("SKIPPED: no usable chromium (" + String(e).split("\n")[0] + ")");
  process.exit(0);
}

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto("file://" + PAGE);
await page.waitForTimeout(2500);

// --- the app comes up at all -------------------------------------------
const html = await page.$eval("#root", (el) => el.innerHTML.length).catch(() => 0);
check("the app renders", html > 500, "#root is empty — a component probably threw");
check("no uncaught errors on load", pageErrors.length === 0, pageErrors[0]);

// --- the manual toggle is where the user was told it is ----------------
const toggle = await page.evaluate(() => {
  const m = [...document.querySelectorAll("label.chk")]
    .find((l) => l.textContent.trim().toLowerCase() === "manual");
  if (!m) return null;
  const tb = m.closest(".tb");
  const txt = tb ? tb.textContent.replace(/\s+/g, " ") : "";
  return { inToolbar: !!tb, nearWindowControls: /Win/.test(txt) && /Ovl/.test(txt) };
});
check("manual window toggle exists", !!toggle, "no 'manual' checkbox found");
check("it sits on the timeline toolbar", !!toggle && toggle.inToolbar);
check("beside the Win / Ovl controls", !!toggle && toggle.nearWindowControls);

// --- handles appear only in manual mode --------------------------------
check("no drag handles before it is on", (await page.$$("\.whandle")).length === 0);

if (toggle) {
  await page.evaluate(() => {
    [...document.querySelectorAll("label.chk")]
      .find((l) => l.textContent.trim().toLowerCase() === "manual")
      .querySelector("input").click();
  });
  await page.waitForTimeout(600);

  const handles = (await page.$$(".whandle")).length;
  check("drag handles appear when it is on", handles > 0, "still none after toggling");

  const labels = await page.$$eval(".wlab", (e) => e.map((x) => x.textContent));
  check("every window shows its length", labels.length > 0, "no size labels drawn");

  // --- dragging a boundary actually resizes both neighbours ------------
  if (handles > 0) {
    const before = labels.slice();
    const h = (await page.$(".whandle.tall")) || (await page.$(".whandle"));
    const b = await h.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 60, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.$$eval(".wlab", (e) => e.map((x) => x.textContent));

    check("dragging a boundary resizes the windows",
      JSON.stringify(before) !== JSON.stringify(after),
      "sizes unchanged: " + JSON.stringify(after));
    check("the window count does not change while dragging",
      before.length === after.length,
      before.length + " -> " + after.length);

    const sum = (arr) => arr.reduce((a, t) => a + parseFloat(t), 0);
    check("the total length is preserved",
      Math.abs(sum(before) - sum(after)) < 0.1,
      sum(before).toFixed(2) + "s -> " + sum(after).toFixed(2) + "s");
    console.log("       " + JSON.stringify(before) + " -> " + JSON.stringify(after));
  }
}

check("no uncaught errors during the run", pageErrors.length === 0, pageErrors[0]);

await browser.close();
console.log();
if (failures.length) {
  console.log(failures.length + " UI CHECK(S) FAILED");
  process.exit(1);
}
console.log("ALL UI CHECKS PASSED");
