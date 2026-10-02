/**
 * A window's length can be TYPED: click its seconds label on the band strip,
 * the number comes up already selected, type the seconds and press Enter.
 * Dragging a boundary cannot always land on an exact value; this can.
 *
 *     cd webui && node uitest_winedit.mjs
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

const frames = () => page.$$eval(".winstrip .band", (e) => e.map((x) => Number(x.dataset.frames)));
const manualOn = () => page.evaluate(() =>
  [...document.querySelectorAll("label.chk")].find((l) => l.textContent.trim().toLowerCase() === "manual")
    .querySelector("input").checked);
const fps = 24;

const before = await frames();
const total = before.reduce((a, b) => a + b, 0);
check("(the demo has several windows, equal ones)", before.length >= 3 && !(await manualOn()), JSON.stringify(before));

// 1. click the first window's seconds
await page.click('[data-testid="wlab-0"]');
await page.waitForTimeout(250);
const box = page.locator('[data-testid="win-edit"]');
check("clicking the seconds opens a box", await box.count() === 1);
const sel = await page.evaluate(() => {
  const el = document.activeElement;
  return el && el.tagName === "INPUT" && el.closest('[data-testid="win-edit"]')
    ? { value: el.value, all: el.selectionStart === 0 && el.selectionEnd === el.value.length } : null;
});
check("the number is focused and already selected", !!sel && sel.all && sel.value === (before[0] / fps).toFixed(2),
  JSON.stringify(sel));
const vis = await box.boundingBox();
check("the box is on screen, not clipped away", !!vis && vis.height > 15 && vis.width > 60, JSON.stringify(vis));

// 2. type and Enter
await page.keyboard.type("5");
await page.waitForTimeout(100);
check("it shows the frames as you type", /120 frames/.test(await box.innerText().catch(() => "")),
  await box.innerText().catch(() => ""));
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const after = await frames();
check("Enter closes the box", await box.count() === 0);
check("the window is now exactly 5.00s (120 frames)", after[0] === 120, JSON.stringify(after));
check("the timeline total is unchanged", after.reduce((a, b) => a + b, 0) === total, `${total} -> ${after.reduce((a, b) => a + b, 0)}`);
check("manual windows were switched on for it", await manualOn());
check("the label says 5.00s", (await page.innerText('[data-testid="wlab-0"]')) === "5.00s");

// 3. the last window: its start moves
const last = after.length - 1;
await page.click(`[data-testid="wlab-${last}"]`);
await page.waitForTimeout(250);
await page.keyboard.type("7.5");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const after2 = await frames();
check("the last window can be typed too (7.50s = 180 frames)", after2[last] === 180 && after2[0] === 120,
  JSON.stringify(after2));
check("  ... total still unchanged", after2.reduce((a, b) => a + b, 0) === total);

// 4. Escape cancels; Backspace inside the box edits the number, not the timeline
await page.click('[data-testid="wlab-1"]');
await page.waitForTimeout(250);
await page.keyboard.press("Backspace");
await page.keyboard.type("9");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape closes without changing anything", await box.count() === 0
  && JSON.stringify(await frames()) === JSON.stringify(after2), JSON.stringify(await frames()));
check("  ... and Backspace in the box removed no window", (await frames()).length === after2.length);

// 5. nonsense is refused and the box stays
await page.click('[data-testid="wlab-1"]');
await page.waitForTimeout(250);
await page.keyboard.type("abc");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check("a non-number is refused, the box stays open to fix it", await box.count() === 1
  && JSON.stringify(await frames()) === JSON.stringify(after2));
await page.keyboard.press("Escape");

// 5b. hand-set windows keep covering the timeline when its length changes:
//     the last window takes up the change, and no window is added at the end
{
  const hand = await frames();
  const setDur = async (v) => {
    const inp = await page.evaluateHandle(() => [...document.querySelectorAll(".time .tb .lbl")]
      .find((l) => l.textContent.trim() === "Duration (s)").nextElementSibling);
    await inp.click({ clickCount: 3 });
    await page.keyboard.type(String(v));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
  };
  const tot = hand.reduce((a, b) => a + b, 0);
  await setDur((tot + 240) / fps);                      // 10 s longer
  let f2 = await frames();
  check("a longer timeline: same windows, the last one 10 s longer",
    f2.length === hand.length && f2.slice(0, -1).join() === hand.slice(0, -1).join()
    && f2[f2.length - 1] === hand[hand.length - 1] + 240, `${JSON.stringify(hand)} -> ${JSON.stringify(f2)}`);
  await setDur((tot - 60) / fps);                       // 2.5 s shorter than before
  f2 = await frames();
  check("a shorter timeline: the last window gives it up, still no extra window",
    f2.length === hand.length && f2[f2.length - 1] === hand[hand.length - 1] - 60
    && f2.reduce((a, b) => a + b, 0) === tot - 60, `${JSON.stringify(hand)} -> ${JSON.stringify(f2)}`);
  await setDur(tot / fps);
  f2 = await frames();
  check("  ... and back again", f2.join() === hand.join(), JSON.stringify(f2));
}

// 6. the Gen panel's window list has no sliders
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button.st")].find((x) => /Generation/.test(x.textContent || ""));
  b && b.click();
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const t = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "Sliding window");
  t && t.click();
});
await page.waitForTimeout(400);
const rows = await page.$$eval(".winlist .row", (e) => e.length);
check("the window list has no slider bars", rows > 0 && await page.$$eval(".winlist input[type=range]", (e) => e.length) === 0,
  `${rows} rows in the list`);

// 8. the clip panel of an audio clip can set the timeline to its length, any time
{
  // make the timeline shorter than the audio first
  const durIn = await page.evaluateHandle(() => [...document.querySelectorAll(".time .tb .lbl")]
    .find((l) => l.textContent.trim() === "Duration (s)").nextElementSibling);
  const durNow = parseFloat(await durIn.evaluate((e) => e.value));
  await durIn.click({ clickCount: 3 });
  await page.keyboard.type(String(Math.max(5, durNow - 5)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const a = await page.$('.trk[data-track="audio"] .seg-c');
  if (a) {
    const ab = await a.boundingBox();
    await page.mouse.click(ab.x + Math.min(40, ab.width / 2), ab.y + ab.height / 2);
    await page.waitForTimeout(300);
    const btn = page.locator('[data-testid="fit-timeline-audio"], [data-testid="fit-timeline-audio-ok"]');
    check("the audio clip's panel offers the timeline length", await btn.count() === 1,
      "no length control (is the clip's duration known?)");
    const fit = page.locator('[data-testid="fit-timeline-audio"]');
    check("  ... as a button, now that the timeline is shorter than it", await fit.count() === 1);
    if (await fit.count()) {
      const want = parseFloat((await fit.innerText()).match(/\(([0-9.]+)s\)/)[1]);
      await fit.click();
      await page.waitForTimeout(400);
      const f3 = await frames();
      check("  ... and sets it, windows still covering it exactly",
        Math.abs(f3.reduce((x, y) => x + y, 0) - Math.round(want * fps)) <= 1
        && await page.locator('[data-testid="fit-timeline-audio-ok"]').count() === 1, JSON.stringify(f3));
    }
  } else {
    check("(the demo has an audio clip to try it on)", false);
  }
}

// 7. a window selected earlier must not be deleted with the audio clip
const nWin = (await frames()).length;
const band = (await page.$$(".winstrip .band"))[1];
const bb = await band.boundingBox();
await band.click({ position: { x: Math.round(bb.width * 0.75), y: Math.round(bb.height / 2) } });
await page.waitForTimeout(200);
check("(a window is selected)", await page.$$eval(".winstrip .band[data-selected]", (e) => e.length) === 1);
const audio = await page.$('.trk[data-track="audio"] .seg-c');
const nAudio = await page.$$eval('.trk[data-track="audio"] .seg-c', (e) => e.length);
if (audio) {
  const ab = await audio.boundingBox();
  await page.mouse.click(ab.x + Math.min(40, ab.width / 2), ab.y + ab.height / 2);
  await page.waitForTimeout(200);
  check("selecting the audio clip unselects the window",
    await page.$$eval(".winstrip .band[data-selected]", (e) => e.length) === 0);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  check("Delete removes the audio clip", await page.$$eval('.trk[data-track="audio"] .seg-c', (e) => e.length) === nAudio - 1);
  check("  ... and NOT the window", (await frames()).length === nWin, `${nWin} -> ${(await frames()).length}`);

} else {
  check("(the demo has an audio clip)", false);
}

// 9. the keyboard moves the playhead: Home, End, Left, Right (Shift: one second)
{
  const ph = () => page.$eval(".ph", (e) => Number(e.dataset.frame));
  const total = (await frames()).reduce((a, b) => a + b, 0);
  await page.mouse.click(5, 5);                          // nothing focused that takes keys
  await page.keyboard.press("Home"); await page.waitForTimeout(120);
  check("Home: to the start", await ph() === 0, await ph());
  await page.keyboard.press("ArrowRight"); await page.waitForTimeout(120);
  check("Right: one frame on", await ph() === 1, await ph());
  await page.keyboard.press("Shift+ArrowRight"); await page.waitForTimeout(120);
  check("Shift+Right: one second on", await ph() === 1 + fps, await ph());
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(120);
  check("Left: one frame back", await ph() === fps, await ph());
  await page.keyboard.press("End"); await page.waitForTimeout(120);
  check("End: to the end of the timeline", await ph() === total, `${await ph()} of ${total}`);
  await page.keyboard.press("ArrowRight"); await page.waitForTimeout(120);
  check("  ... and no further", await ph() === total, await ph());
  await page.keyboard.press("Shift+ArrowLeft"); await page.waitForTimeout(120);
  check("Shift+Left: one second back", await ph() === total - fps, await ph());
  // typing in a box must not move it
  await page.click('[data-testid="wlab-0"]'); await page.waitForTimeout(200);
  const before = await ph();
  await page.keyboard.press("Home"); await page.keyboard.press("End");
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  check("  ... but not while typing in a box", await ph() === before, `${before} -> ${await ph()}`);
}

// 10. in manual mode "- window" is always there, not only once a window is selected
{
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");                   // nothing selected
  await page.waitForTimeout(150);
  const btn = page.locator('[data-testid="remove-window"]');
  check("in manual mode the remove-window button is there with no window selected",
    await manualOn() && await btn.count() === 1 && !(await btn.isDisabled()));
  const w = await frames();
  // the playhead into the second window, then remove
  await page.keyboard.press("Home"); await page.waitForTimeout(100);
  for (let i = 0; i < Math.ceil((w[0] + 5) / fps); i++) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(150);
  await btn.click();
  await page.waitForTimeout(300);
  const w2 = await frames();
  check("  ... and it removes the window under the playhead (the second, folded into the next)",
    w2.length === w.length - 1 && w2[0] === w[0] && w2[1] === w[1] + w[2],
    `${JSON.stringify(w)} -> ${JSON.stringify(w2)}`);
  check("  ... the timeline total is unchanged", w2.reduce((a, b) => a + b, 0) === w.reduce((a, b) => a + b, 0));
}

check("no uncaught errors", errors.length === 0, errors[0]);
await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} WINDOW-EDIT CHECK(S) FAILED`); process.exit(1); }
console.log("ALL WINDOW-EDIT CHECKS PASSED");
