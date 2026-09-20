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
  // The "Win" label must come AFTER the toggle in document order.
  const winLabel = [...document.querySelectorAll(".tb .lbl")]
    .find((l) => l.textContent.trim() === "Win");
  const before = winLabel
    ? !!(m.compareDocumentPosition(winLabel) & Node.DOCUMENT_POSITION_FOLLOWING)
    : false;
  return {
    inToolbar: !!tb,
    nearWindowControls: /Win/.test(txt) && /Ovl/.test(txt),
    beforeWin: before,
  };
});
check("manual window toggle exists", !!toggle, "no 'manual' checkbox found");
check("it sits on the timeline toolbar", !!toggle && toggle.inToolbar);
check("beside the Win / Ovl controls", !!toggle && toggle.nearWindowControls);
check("it comes immediately before Win", !!toggle && toggle.beforeWin,
  "the toggle is after the Win control");

// the window-size box is live until lengths are set by hand
const winBox = () => page.evaluate(() => {
  const lbl = [...document.querySelectorAll(".tb .lbl")]
    .find((l) => l.textContent.trim() === "Win");
  const input = lbl && lbl.nextElementSibling;
  return input ? { disabled: !!input.disabled } : null;
});
const winBefore = await winBox();
check("the Win box is enabled in automatic mode", !!winBefore && !winBefore.disabled);

// --- handles appear only in manual mode --------------------------------
check("no drag handles before it is on", (await page.$$("\.whandle")).length === 0);

// Where the borders sit while the plugin is choosing the windows itself.
// Flipping to manual must hand back exactly these windows: the user asked
// for control of the layout, not a different layout.
const bordersOf = () => page.$$eval(".winstrip .band",
  (e) => e.map((x) => Number(x.dataset.frames)));
const autoBorders = await bordersOf();

if (toggle) {
  await page.evaluate(() => {
    [...document.querySelectorAll("label.chk")]
      .find((l) => l.textContent.trim().toLowerCase() === "manual")
      .querySelector("input").click();
  });
  await page.waitForTimeout(600);

  const handles = (await page.$$(".whandle")).length;
  check("drag handles appear when it is on", handles > 0, "still none after toggling");

  // Switching to manual must never immediately show a problem. The seeded
  // layout used to flag itself: the model's own 362-frame window was compared
  // against a literal 15s (360 frames), and short timelines seeded runts.
  const seeded = await page.$$eval(".winstrip .band",
    (e) => e.map((x) => ({ sec: parseFloat(x.dataset.sec), bad: x.dataset.bad || "" })));
  check("switching to manual shows no red windows",
    seeded.every((b) => !b.bad),
    "flagged on entry: " + JSON.stringify(seeded));
  console.log("       seeded layout: " +
    seeded.map((b) => b.sec.toFixed(2) + "s").join(", "));

  // The borders must not jump just because the toggle was clicked.
  const manualBorders = await bordersOf();
  check("the borders do not move when switching to manual",
    autoBorders.length === manualBorders.length &&
      autoBorders.every((f, i) => f === manualBorders[i]),
    "auto " + autoBorders.join(",") + "  ->  manual " + manualBorders.join(","));

  const winAfter = await winBox();
  check("the Win box is disabled in manual mode", !!winAfter && winAfter.disabled,
    "the window-size box is still editable and no longer means anything");

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

    // --- how far can the boundary actually travel? --------------------
    // Trading only with the immediate neighbour stopped the boundary dead
    // after ~8s, because the neighbour hit its ceiling first. Dragging the
    // full width should reach the model's real floor and ceiling.
    const bandSecs = () =>
      page.$$eval(".winstrip .band", (e) => e.map((x) => parseFloat(x.dataset.sec)));
    const firstOf = async () => (await bandSecs())[0];
    const sweep = async (toX) => {
      const bb = await h.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await page.mouse.move(toX, bb.y + bb.height / 2, { steps: 25 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      return firstOf();
    };
    const page_w = page.viewportSize().width;
    const lo = await sweep(4);
    const hi = await sweep(page_w - 4);
    const travel = hi - lo;
    check("the boundary travels freely, not just between two windows",
      travel > 10,
      "only " + travel.toFixed(2) + "s of travel — it is still hitting a wall");
    console.log("       window 1 reaches " + lo.toFixed(2) + "s .. " + hi.toFixed(2) +
                "s  (" + travel.toFixed(2) + "s of travel)");

    // Arranging a layout means being allowed to overshoot. The border must
    // NOT stop at the model's limits -- those are reported, not enforced here.
    check("dragging is allowed BELOW the model minimum (4.46s)", lo < 4.46,
      "stopped at " + lo.toFixed(2) + "s — the drag is still being clamped");
    check("dragging is allowed ABOVE the per-window maximum (19.29s)", hi > 19.29,
      "stopped at " + hi.toFixed(2) + "s — the drag is still being clamped");

    // ...and an out-of-range window has to be visible before Generate.
    const flagged = await page.$$eval(".winstrip .band[data-bad]", (e) => e.length);
    check("an out-of-range window is coloured on the timeline", flagged > 0,
      "no band was flagged after dragging past the limits");

    const sumNow = (await bandSecs()).reduce((a, b) => a + b, 0);
    check("the total survives a full-width sweep",
      Math.abs(sumNow - sum(before)) < 0.5,
      sum(before).toFixed(2) + "s -> " + sumNow.toFixed(2) + "s");
  }
}

// --- an out-of-range band must be OBVIOUSLY different, not a near-match ----
// The first attempt used an amber almost identical to the normal alternating
// band colour, so a bad window looked like an ordinary one.
{
  const cols = await page.$$eval(".winstrip .band", (els) =>
    els.map((b) => ({ bad: b.dataset.bad || "", bg: b.style.background })));
  const parse = (c) => (c.match(/\d+/g) || []).slice(0, 3).map(Number);
  const badCols = cols.filter((c) => c.bad).map((c) => parse(c.bg));
  // The normal alternating palette, which "bad" must not resemble.
  const okCols = [[64, 118, 208], [208, 148, 64]];
  if (badCols.length) {
    const isRed = badCols.every(([r, g, b]) => r > 180 && r - g > 100 && r - b > 100);
    check("an out-of-range band is unmistakably red", isRed,
      "bad bands are " + JSON.stringify(badCols));
    const far = badCols.every(([r1, g1, b1]) =>
      okCols.every(([r2, g2, b2]) =>
        Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) > 120));
    check("it is not a near-match for a normal band", far,
      "bad " + JSON.stringify(badCols) + " vs normal " + JSON.stringify(okCols));
  } else {
    check("there was an out-of-range band to check", badCols.length > 0);
  }
}

// --- the borders hold at every timeline length -----------------------------
// Laying the timeline out in automatic mode and then clicking manual must hand
// back the SAME borders. Two things used to move them: manual seeded itself
// with an even division instead of the drawn plan, and it preferred a layout
// saved earlier in the project over the one on screen. 16s and 32s are the
// lengths whose automatic plan ends in a short tail -- exactly the ones that
// used to be re-evened.
{
  const setDuration = async (secs) => {
    const handle = await page.evaluateHandle(() => {
      const lbl = [...document.querySelectorAll(".tb .lbl")]
        .find((l) => l.textContent.trim().startsWith("Duration"));
      if (!lbl) return null;
      let n = lbl.nextElementSibling;
      while (n && n.tagName !== "INPUT") n = n.querySelector ? n.querySelector("input") : null;
      return n;
    });
    const input = handle.asElement();
    if (!input) return false;
    await input.click({ clickCount: 3 });
    await page.keyboard.press("Control+A");
    await page.keyboard.type(String(secs));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(450);
    return true;
  };
  const setManual = async (on) => {
    await page.evaluate((want) => {
      const box = [...document.querySelectorAll("label.chk")]
        .find((l) => l.textContent.trim().toLowerCase() === "manual")
        .querySelector("input");
      if (box.checked !== want) box.click();
    }, on);
    await page.waitForTimeout(400);
  };
  const borders = () => page.$$eval(".winstrip .band",
    (e) => e.map((x) => Number(x.dataset.frames)));

  const moved = [];
  const reds = [];
  for (const secs of [16, 30, 32, 45, 60, 75]) {
    await setManual(false);
    if (!(await setDuration(secs))) break;
    const before = await borders();
    await setManual(true);
    const after = await borders();
    const same = before.length === after.length && before.every((f, i) => f === after[i]);
    if (!same) moved.push(`${secs}s: [${before}] -> [${after}]`);
    const bad = await page.$$eval(".winstrip .band",
      (e) => e.filter((x) => x.dataset.bad).length);
    if (bad) reds.push(`${secs}s: ${bad} red`);
  }
  check("the borders hold at every timeline length", moved.length === 0,
    moved.join("   |   "));
  check("and none of those layouts starts out red", reds.length === 0,
    reds.join("   |   "));

  // Toggling off and straight back on must be a no-op too: the saved layout
  // used to win over what was on screen.
  await setManual(false);
  const autoAgain = await borders();
  await setManual(true);
  await setManual(false);
  await setManual(true);
  const afterCycles = await borders();
  check("toggling manual off and on twice changes nothing",
    autoAgain.length === afterCycles.length && autoAgain.every((f, i) => f === afterCycles[i]),
    "[" + autoAgain + "] -> [" + afterCycles + "]");
  // Hand the next block the state it expects: manual on, so the Sliding Window
  // panel shows its Windows +/- control.
  await setManual(true);
}

// --- adding windows: a short timeline split into several -------------------
{
  // NumField commits on blur / Enter, so drive it like a person would.
  const setDur = async (secs) => {
    const handle = await page.evaluateHandle(() => {
      const lbl = [...document.querySelectorAll(".tb .lbl")]
        .find((l) => l.textContent.trim().startsWith("Duration"));
      if (!lbl) return null;
      let n = lbl.nextElementSibling;
      while (n && n.tagName !== "INPUT") n = n.querySelector ? n.querySelector("input") : null;
      return n;
    });
    const input = handle.asElement();
    if (!input) return false;
    await input.click({ clickCount: 3 });
    await page.keyboard.press("Control+A");
    await page.keyboard.type(String(secs));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    return true;
  };
  const durOk = await setDur(15);
  check("the timeline duration could be set for this test", durOk,
    "could not find the Duration field");

  // The Sliding window tab lives inside the Generation pane, so open that first.
  await page.evaluate(() => {
    const rail = [...document.querySelectorAll("button, [role=button], .rail-item, li, div")]
      .find((b) => (b.textContent || "").trim().startsWith("Generation"));
    if (rail) rail.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")]
      .find((b) => /^sliding window$/i.test((b.textContent || "").trim()));
    if (tab) tab.click();
  });
  await page.waitForTimeout(400);

  const plus = await page.evaluateHandle(() => {
    const row = [...document.querySelectorAll(".row")]
      .find((r) => r.querySelector("label") &&
                   r.querySelector("label").textContent.trim() === "Windows");
    return row ? [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "+") : null;
  });
  const el = plus.asElement();
  if (el) {
    const counts = [];
    for (let k = 0; k < 2; k++) {
      await el.click();
      await page.waitForTimeout(350);
      counts.push((await page.$$(".winstrip .band")).length);
    }
    check("adding windows works on a short timeline", counts[counts.length - 1] >= 3,
      "band count went " + JSON.stringify(counts));
    const secs = await page.$$eval(".winstrip .band",
      (e) => e.map((x) => parseFloat(x.dataset.sec)));
    const tot = secs.reduce((a, b) => a + b, 0);
    check("the split windows still add up to the timeline",
      Math.abs(tot - 15) < 0.2, tot.toFixed(2) + "s for a 15.00s timeline");
    console.log("       15s timeline as " + secs.length + " windows: " +
                JSON.stringify(secs.map((x) => x.toFixed(2))));
  } else {
    check("the Windows +/- control exists", false, "not found in the Sliding Window panel");
  }
}

// --- select a window, then remove it with the keyboard --------------------
{
  const bands = () => page.$$(".winstrip .band");
  const count = async () => (await bands()).length;
  const secs = () => page.$$eval(".winstrip .band", (e) => e.map((x) => parseFloat(x.dataset.sec)));

  const n0 = await count();
  const total0 = (await secs()).reduce((a, b) => a + b, 0);

  // click the second band to select it
  const all = await bands();
  if (all.length >= 2) {
    await all[1].click();
    await page.waitForTimeout(300);
    const sel = await page.$$eval(".winstrip .band[data-selected]", (e) => e.length);
    check("clicking a window selects it", sel === 1,
      sel + " bands report as selected");

    await page.keyboard.press("Delete");
    await page.waitForTimeout(350);
    const n1 = await count();
    check("Delete removes the selected window", n1 === n0 - 1,
      n0 + " windows -> " + n1);
    const total1 = (await secs()).reduce((a, b) => a + b, 0);
    check("removing a window keeps the total", Math.abs(total1 - total0) < 0.2,
      total0.toFixed(2) + "s -> " + total1.toFixed(2) + "s");

    // Backspace as well
    const before2 = await count();
    (await bands())[0] && await (await bands())[0].click();
    await page.waitForTimeout(250);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(350);
    check("Backspace removes it too", (await count()) === before2 - 1,
      before2 + " windows -> " + (await count()));

    // --- + window adds a boundary at the playhead -----------------------
    const before3 = await count();
    const total3 = (await secs()).reduce((a, b) => a + b, 0);
    const addBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll(".tb button")]
        .find((b) => /\+\s*window/i.test(b.textContent || "")));
    const ab = addBtn.asElement();
    check("there is an Add window button", !!ab, "no '+ window' button on the toolbar");
    if (ab) {
      await ab.click();
      await page.waitForTimeout(350);
      const after3 = await count();
      check("+ window adds a window", after3 === before3 + 1,
        before3 + " windows -> " + after3);
      const total4 = (await secs()).reduce((a, b) => a + b, 0);
      check("adding a window keeps the total", Math.abs(total4 - total3) < 0.2,
        total3.toFixed(2) + "s -> " + total4.toFixed(2) + "s");
      console.log("       " + before3 + " windows -> " + after3 +
                  ", total " + total4.toFixed(2) + "s");
    }
  } else {
    check("there were enough windows to test selection", false);
  }
}

// --- PDD off must really turn PDD off --------------------------------------
// Unchecking used to set only `pdd: false` and leave steps at 8, so the job
// still ran as an 8-step PDD generation with nothing on screen to say so.
{
  await page.evaluate(() => {
    const rail = [...document.querySelectorAll("button, [role=button], .rail-item, li, div")]
      .find((b) => (b.textContent || "").trim().startsWith("Generation"));
    if (rail) rail.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")]
      .find((b) => /^general$/i.test((b.textContent || "").trim()));
    if (tab) tab.click();
  });
  await page.waitForTimeout(300);

  const stepsVal = () => page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => {
      const l = r.querySelector("label");
      return l && /number of inference steps/i.test(l.textContent || "");
    });
    if (!row) return null;
    const rng = row.querySelector("input[type=range]");
    return rng ? Number(rng.value) : null;
  });
  const pddBox = () => page.evaluateHandle(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => {
      const l = r.querySelector("label");
      return l && /pdd/i.test(l.textContent || "");
    });
    return row ? row.querySelector("input[type=checkbox]") : null;
  });

  const before = await stepsVal();
  const boxH = await pddBox();
  const box = boxH.asElement();
  check("the PDD toggle and steps slider were found", !!box && before != null,
    "steps=" + before);

  if (box && before != null) {
    await box.click();                      // PDD on
    await page.waitForTimeout(350);
    const on = await stepsVal();
    check("PDD on sets 8 steps", on === 8, "steps became " + on);

    await box.click();                      // PDD off
    await page.waitForTimeout(350);
    const off = await stepsVal();
    check("PDD off restores the normal step count", off !== 8 && off === before,
      "steps stayed at " + off + " (was " + before + " before PDD)");
    console.log("       steps " + before + " -> PDD on " + on + " -> PDD off " + off);
  }
}

// --- double-click a reference to inspect it --------------------------------
{
  await page.evaluate(() => {
    const rail = [...document.querySelectorAll("button, [role=button], .rail-item, li, div")]
      .find((b) => (b.textContent || "").trim().startsWith("References"));
    if (rail) rail.click();
  });
  await page.waitForTimeout(500);

  const thumbs = await page.$$(".ref .th");
  check("there are reference tiles to open", thumbs.length > 0,
    "no .ref .th tiles in the References pane");

  if (thumbs.length) {
    await thumbs[0].dblclick();
    await page.waitForTimeout(600);
    const open = await page.$(".pv");
    check("double-clicking a reference opens the viewer", !!open,
      "no preview panel appeared");

    if (open) {
      // it should actually show something, not an empty shell
      const kinds = await page.evaluate(() => ({
        img: !!document.querySelector(".pv-b img"),
        vid: !!document.querySelector(".pv-b video"),
        aud: !!document.querySelector(".pv-b audio"),
        err: !!document.querySelector(".pv-b .err"),
      }));
      check("the viewer shows the media itself",
        kinds.img || kinds.vid || kinds.aud || kinds.err,
        "nothing rendered inside the viewer: " + JSON.stringify(kinds));

      // draggable by the title bar
      const head = await page.$(".pv-h");
      const b0 = await open.boundingBox();
      const hb = await head.boundingBox();
      await page.mouse.move(hb.x + 40, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + 40 + 90, hb.y + hb.height / 2 + 60, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      const b1 = await open.boundingBox();
      check("the viewer can be dragged by its title bar",
        Math.abs(b1.x - b0.x) > 20 || Math.abs(b1.y - b0.y) > 20,
        "it did not move: " + JSON.stringify([b0.x, b0.y]) + " -> " + JSON.stringify([b1.x, b1.y]));

      const resizable = await page.$eval(".pv",
        (el) => getComputedStyle(el).resize);
      check("the viewer is resizable", resizable === "both",
        "CSS resize is '" + resizable + "'");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check("Escape closes the viewer", !(await page.$(".pv")));
      console.log("       viewer moved " + Math.round(b1.x - b0.x) + "," +
                  Math.round(b1.y - b0.y) + "px and resizes '" + resizable + "'");
    }
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
