/**
 * Browser test for Continue: the UI inside a stand-in for Wan2GP.
 *
 * The built page is loaded in an iframe exactly as the plugin loads it, and
 * the parent answers the bridge the way Python does. That exercises the real
 * wiring -- what is asked for, what is sent, and what a person sees -- with
 * the render record's answers scripted:
 *
 *   * an unfinished render shows a Continue button and a card saying how
 *     much is done, and says so on load;
 *   * Continue sends generate with resume;
 *   * Generate never throws the finished groups away without asking, and
 *     Cancel on that question sends nothing;
 *   * a render that cannot be kept says why, and offers no Continue;
 *   * Discard asks, then clears.
 *
 *     cd webui && node uitest_resume.mjs
 */
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "..", "assets", "index.html");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIPPED: playwright not installed");
  process.exit(0);
}
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"].find((p) => existsSync(p));
if (!existsSync(PAGE)) { console.log("SKIPPED: assets/index.html not built yet"); process.exit(0); }

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const RESUMABLE = {
  has_record: true, running: false, resumable: true, complete: false,
  recorded_groups: 2, kept_groups: 2, kept_windows: 4, total_windows: 5,
  kept_seconds: 16.9, total_seconds: 21.6, reason: null, notes: [], seed: 123456,
};

const dir = mkdtempSync(join(tmpdir(), "h3d-resume-ui-"));
const host = join(dir, "host.html");
writeFileSync(host, `<!doctype html><html><body style="margin:0">
<iframe id="f" src="file://${PAGE}" style="width:1580px;height:1080px;border:0"></iframe>
<script>
  // Stand-in for the plugin's side of the bridge.
  window.sent = [];
  window.renderState = ${JSON.stringify(RESUMABLE)};
  const f = document.getElementById("f");
  const reply = (id, data) => f.contentWindow.postMessage({ source: "h3d2_parent", id, data }, "*");
  window.jobStatus = "idle";   // what job_state reports, as Python would
  window.push = (cmd, data) => {
    if (cmd === "gen" && data.status !== "running") window.jobStatus = "idle";
    f.contentWindow.postMessage({ source: "h3d2_parent", cmd, data }, "*");
  };
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.source !== "h3d2_frame") return;
    window.sent.push({ cmd: m.cmd, data: m.data });
    if (m.cmd === "generate") window.jobStatus = "running";
    if (!m.id) return;
    if (m.cmd === "render_state") return reply(m.id, window.renderState);
    // A split runs in the background, as in Python: render_split answers at
    // once and split_state tells how far it has got. splitHold keeps it
    // running until the test lets go; splitFail makes it end in an error.
    if (m.cmd === "render_split") {
      window.splitJob = { state: "running", group: m.data.group, done: 0, total: 2, step: "reading the clip", elapsed: 0, n: 0 };
      return reply(m.id, { ok: true, started: true, group: m.data.group, pieces: 2 });
    }
    if (m.cmd === "split_state") {
      const j = window.splitJob || { state: "idle" };
      if (j.state === "running" && !window.splitHold) {
        j.n += 1;
        j.done = Math.min(2, j.n - 1);
        j.step = "cutting piece " + (j.done + 1) + " of 2";
        if (j.n >= 3) Object.assign(j, window.splitFail ? { state: "error", error: window.splitFail } : { state: "done", done: 2, step: "done" });
      }
      return reply(m.id, { ...j });
    }
    // an installed model, so the "no H3 models" notice never covers the ones tested here
    if (m.cmd === "list_models") return reply(m.id, { models: [{ model_type: "minimax_h3_hybrid", name: "H3 Hybrid" }] });
    if (m.cmd === "render_discard") { window.renderState = { has_record: false, running: false, resumable: false, complete: false }; return reply(m.id, { ok: true, removed: 2 }); }
    if (m.cmd === "load_project_json") return reply(m.id, { payload: null });
    if (m.cmd === "render_poster") {
      // a strip as Python makes it: one 16:9 tile per frame, side by side
      const n = [4, 8, 16, 32, 48].find((c) => c >= (m.data.count || 0)) || 48;
      const tiles = Array.from({ length: n }, (_, i) =>
        '<rect x="' + i * 100 + '" width="100" height="56" fill="hsl(' + Math.round(360 * i / n) + ',60%,45%)"/>').join("");
      return reply(m.id, { master: m.data.master, count: n, tile_w: 100, tile_h: 56,
        data: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="' + n * 100 + '" height="56">' + tiles + '</svg>') });
    }
    if (m.cmd === "save_project_json") return reply(m.id, { ok: true, bytes: 10 });
    if (m.cmd === "job_state") return reply(m.id, { status: window.jobStatus, attached: true, log: [], files: [] });
    reply(m.id, { ok: true });
  });
</script></body></html>`);

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + host);
await page.waitForTimeout(2500);
const app = page.frameLocator("#f");
const frame = page.frames().find((fr) => fr.url().endsWith("index.html"));
const sent = () => page.evaluate(() => window.sent);
const generates = async () => (await sent()).filter((m) => m.cmd === "generate");
const toast = () => frame.evaluate(() => document.body.innerText);
const splitIdle = async (ms = 8000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await app.locator('[data-testid="split-status"]').count() === 0) return true;
    await page.waitForTimeout(200);
  }
  return false;
};
const endRun = async (status = "error") => {
  await page.evaluate((st) => window.push("gen", { status: st, progress: 1, logs: [] }), status);
  await page.waitForTimeout(700);
};

check("the app comes up inside the host", !!frame && errors.length === 0, errors[0]);
check("it asks Python about an unfinished render on load",
  (await sent()).some((m) => m.cmd === "render_state"));
check("and says one can be continued", /unfinished render can be continued/i.test(await toast()));

check("the results lane is on the timeline from the start",
  await frame.evaluate(() => {
    const l = document.querySelector(".trk.results");
    const t = document.querySelector("section.time")?.getBoundingClientRect();
    return !!l && !!t && l.getBoundingClientRect().bottom <= t.bottom + 1;
  }));
const cont = app.locator('[data-testid="continue-render"]');
check("a Continue button sits in the action bar", await cont.count() === 1);
check("  ... saying how much is done", /Continue \(0:17 of 0:22 done\)/.test(await cont.innerText().catch(() => "")),
  await cont.innerText().catch(() => "none"));

// the card in the Generation pane
await app.locator(".rail button", { hasText: "Generation" }).first().click();
await page.waitForTimeout(300);
const card = app.locator('[data-testid="resume-card"]');
check("the Generation pane shows the unfinished render", await card.count() === 1);
const cardText = await card.innerText().catch(() => "");
check("  ... with groups, time, windows and seed",
  /2 groups finished/.test(cardText) && /4 of 5 windows/.test(cardText) && /123456/.test(cardText), cardText);
check("  ... and where Continue picks up", /window 5/.test(cardText), cardText);

// Generate while a render can be continued KEEPS the finished groups: it
// continues, it does not start over, and it does not ask.
await app.locator(".act button", { hasText: /^Generate$/ }).click();
await page.waitForTimeout(1500);
let gens = await generates();
check("Generate keeps the finished groups: it continues, without asking",
  gens.length === 1 && gens[0].data.resume === true && !gens[0].data.discard_ok
  && (await app.locator(".sheet.confirm").count()) === 0, JSON.stringify(gens.map((g) => g.data)));
await endRun("cancelled");

// Continue
await app.locator('[data-testid="continue-render"]').click();
await page.waitForTimeout(1500);
gens = await generates();
check("Continue sends generate with resume", gens.length === 2 && gens[1].data.resume === true,
  JSON.stringify(gens.map((g) => g.data.resume)));
check("  ... and never says they may be discarded", !gens[1]?.data?.discard_ok);
check("  ... with the timeline plan and length",
  !!gens[1]?.data?.settings && gens[1].data.target_frames > 0);
const stat = await app.locator(".act .stat").innerText().catch(() => "");
check("while it runs there is no Continue to press twice",
  await app.locator('[data-testid="continue-render"]').count() === 0,
  "status bar: " + stat.replace(/\s+/g, " "));

// A render that cannot be kept
await page.evaluate(() => {
  window.renderState = { has_record: true, running: false, resumable: false, complete: false,
    recorded_groups: 2, kept_groups: 0, kept_windows: 0, total_windows: 5, kept_seconds: 0,
    total_seconds: 21.6, reason: "settings that apply to every group changed: num_inference_steps",
    notes: [], seed: 123456,
    clips: [{ group: 1, first_window: 0, n_windows: 2, start: 0, frames: 700, frames_got: 700, master: "a.mkv",
              status: "redo", why: "settings changed" },
            { group: 2, first_window: 2, n_windows: 2, start: 700, frames: 700, frames_got: 700, master: "b.mkv",
              status: "after", why: "" }] };
});
await endRun("error");
check("when nothing can be kept, Continue goes away",
  await app.locator('[data-testid="continue-render"]').count() === 0);
const card2 = await app.locator('[data-testid="resume-card"]').innerText().catch(() => "");
check("  ... and the card says why", /num_inference_steps/.test(card2) && /start over/i.test(card2), card2);
await app.locator(".act button", { hasText: /^Generate$/ }).click();
await page.waitForTimeout(500);
const ask = await app.locator(".sheet.confirm").innerText().catch(() => "");
check("Generate asks before replacing clips that cannot be kept, and says why",
  /cannot be kept/.test(ask) && /num_inference_steps/.test(ask) && (await generates()).length === 2, ask);
await app.locator(".sheet.confirm button", { hasText: "Render again" }).click();
await page.waitForTimeout(1500);
const g3 = await generates();
check("  ... and on Render again it sends a fresh render that may replace them",
  g3.length === 3 && g3[2].data.discard_ok === true && !g3[2].data.resume, JSON.stringify(g3.map((g) => g.data.discard_ok)));
await endRun("error");

// The results track
const bands = await frame.evaluate(() =>
  [...document.querySelectorAll(".winstrip .band")].map((b) => ({
    frames: Number(b.dataset.frames), left: b.getBoundingClientRect().left })));
const starts = bands.reduce((acc, b, i) => (acc.push(i ? acc[i - 1] + bands[i - 1].frames : 0), acc), []);
const clip = (group, w0, n, status, why = "") => ({
  group, first_window: w0, n_windows: n, start: starts[w0],
  frames: bands.slice(w0, w0 + n).reduce((a, b) => a + b.frames, 0),
  frames_got: bands.slice(w0, w0 + n).reduce((a, b) => a + b.frames, 0),
  master: `group_w${w0 + 1}.mkv`, bytes: 1000 + group, seed: 123456, finished: "2026-09-25 21:40:00",
  windows: bands.slice(w0, w0 + n).map((b) => b.frames), status, why });
const laneState = { ...RESUMABLE, running: true, resumable: false,
  clips: [clip(1, 0, 2, "done"), clip(2, 2, 1, "redo", "the prompt or media for group 2 changed")],
  active: { group: 3, first_window: 3, n_windows: bands.length - 3, start: starts[3],
            frames: bands.slice(3).reduce((a, b) => a + b.frames, 0) } };
await page.evaluate((st) => { window.renderState = st; }, laneState);
await page.evaluate(() => window.push("gen", { status: "running", logs: [{ level: "ok", msg: "Group 2 done: x.mp4" }] }));
await page.waitForTimeout(900);
const lane = await frame.evaluate(() => {
  const l = document.querySelector('.trk.results');
  if (!l) return null;
  const time = document.querySelector("section.time").getBoundingClientRect();
  const lr = l.getBoundingClientRect();
  return {
    appGrew: document.querySelector(".app").classList.contains("has-results"),
    visible: lr.bottom <= time.bottom + 1 && lr.height > 20,
    clips: [...l.querySelectorAll(".rclip")].map((c) => ({
      status: c.dataset.status, left: c.getBoundingClientRect().left,
      right: c.getBoundingClientRect().right, label: c.innerText, title: c.title })),
  };
});
check("a results lane appears once groups are rendered", !!lane);
check("  ... and the timeline grows so nothing above is squeezed", !!lane?.appGrew);
check("  ... fully visible", !!lane?.visible);
check("one block per finished group, plus the one rendering",
  lane?.clips.length === 3 && lane.clips.map((c) => c.status).join() === "done,redo,rendering",
  JSON.stringify(lane?.clips.map((c) => c.status)));
const near = (a, b) => Math.abs(a - b) <= 1.5;
check("each block starts exactly where its first window starts",
  !!lane && near(lane.clips[0].left, bands[0].left) && near(lane.clips[1].left, bands[2].left)
  && near(lane.clips[2].left, bands[3].left),
  JSON.stringify({ clips: lane?.clips.map((c) => c.left), bands: bands.map((b) => b.left) }));
check("and ends where the next begins",
  !!lane && near(lane.clips[0].right, lane.clips[1].left) && near(lane.clips[1].right, lane.clips[2].left));
check("a block says what it is and why it will be redone",
  /Group 2: window 3/.test(lane?.clips[1].title || "") && /prompt or media for group 2 changed/.test(lane?.clips[1].title || ""),
  lane?.clips[1].title);
check("the rendering group says so", /G3 · rendering/.test(lane?.clips[2].label || ""));
check("posters are asked for, one per clip",
  new Set((await sent()).filter((m) => m.cmd === "render_poster" && /^group_w/.test(m.data.master)).map((m) => m.data.master)).size === 2);
await page.waitForTimeout(400);
{
  const strip = await frame.evaluate(() => [...document.querySelectorAll(".rclip")].filter((c) => c.querySelector(".rstrip")).map((c) => {
    const r = c.getBoundingClientRect();
    const tiles = [...c.querySelectorAll(".rtile")].map((t) => t.getBoundingClientRect());
    return { w: r.width, n: tiles.length, tw: tiles[0]?.width, th: tiles[0]?.height,
      end: tiles.length ? tiles[tiles.length - 1].right - r.left : 0,
      frames: [...c.querySelectorAll(".rtile")].map((t) => Number(t.dataset.frame)),
      count: Number(c.querySelector(".rstrip").dataset.count), bg: getComputedStyle(c).backgroundImage };
  }));
  check("each finished clip shows a filmstrip", strip.length === 2, JSON.stringify(strip));
  check("  ... its frames at their true shape (16:9 here), not stretched to fill the clip",
    strip.every((x) => Math.abs(x.tw / x.th - 100 / 56) < 0.02 && x.bg === "none"), JSON.stringify(strip.map((x) => [x.tw, x.th, x.bg])));
  check("  ... as many as it takes to fill the clip's width",
    strip.every((x) => x.end >= x.w - 1 && x.n === Math.ceil(x.w / x.tw)), JSON.stringify(strip.map((x) => [x.w, x.n, x.end])));
  check("  ... from a strip with at least that many frames, each tile showing its own moment in order",
    strip.every((x) => x.count >= Math.min(48, x.n) && x.frames.every((f, i, a) => i === 0 || f >= a[i - 1])
      && new Set(x.frames).size === Math.min(x.n, x.count)), JSON.stringify(strip.map((x) => [x.count, x.frames])));
  await page.screenshot({ path: resolve(dir, "filmstrip.png"), clip: { x: 0, y: 250, width: 1600, height: 170 } });
}
await page.screenshot({ path: resolve(dir, "results-lane.png"), clip: { x: 0, y: 0, width: 1600, height: 420 } });

// ---- marking clips and regenerating them ----
const doneState = { ...RESUMABLE, resumable: false, complete: true,
  clips: [clip(1, 0, 2, "done"), clip(2, 2, 1, "redo", "the prompt or media for group 2 changed"),
          { ...clip(3, 3, bands.length - 3, "after", "renders again after group 2") }], active: null };
await page.evaluate((st) => { window.renderState = st; window.jobStatus = "idle"; }, doneState);
await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(dir, "results-split.png"), clip: { x: 0, y: 250, width: 1600, height: 170 } });
// A clip of several windows shows where they meet, and can be split into them
check("a two-window clip shows where its windows meet", await frame.evaluate(() =>
  document.querySelectorAll('.rclip[data-group="1"] .rwin').length === 1
  && document.querySelectorAll('.rclip[data-group="2"] .rwin').length === 0));
check("  ... and has a split button; a one-window clip does not",
  await app.locator('[data-testid="split-1"]').count() === 1 && await app.locator('[data-testid="split-2"]').count() === 0);
{
  const n0 = (await sent()).filter((m) => m.cmd === "render_split").length;
  await app.locator('[data-testid="split-1"]').click();
  await page.waitForTimeout(700);
  const sp = (await sent()).filter((m) => m.cmd === "render_split");
  check("  ... which asks Python to split exactly that clip", sp.length === n0 + 1 && sp[sp.length - 1].data.group === 1,
    JSON.stringify(sp.map((x) => x.data.group)));
  check("  ... and it finishes", await splitIdle());
  check("  ... and the button says what it does", /Split/.test(await app.locator('[data-testid="split-1"]').innerText()));
  // right-click menu
  const c1 = app.locator('.rclip[data-group="1"]');
  await c1.click({ button: "right", position: { x: 40, y: 10 } });
  await page.waitForTimeout(250);
  const menu = app.locator('[data-testid="clip-menu"]');
  await page.screenshot({ path: resolve(dir, "results-menu.png"), clip: { x: 0, y: 250, width: 1000, height: 260 } });
  check("right-clicking a clip opens its menu", await menu.count() === 1
    && /Split into its 2 windows/.test(await menu.innerText()), await menu.innerText().catch(() => "no menu"));
  const nm = (await sent()).filter((m) => m.cmd === "render_split").length;
  await app.locator('[data-testid="menu-split"]').click();
  await page.waitForTimeout(600);
  check("  ... and Split there splits that clip, and closes the menu",
    (await sent()).filter((m) => m.cmd === "render_split").length === nm + 1 && await menu.count() === 0);
  await splitIdle();
  await app.locator('.rclip[data-group="2"]').click({ button: "right", position: { x: 40, y: 10 } });
  await page.waitForTimeout(250);
  check("  ... a one-window clip cannot be split from it", await app.locator('[data-testid="menu-split"]').isDisabled());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("  ... Esc closes it", await menu.count() === 0);
  check("  ... and does not mark it or open the monitor", JSON.stringify(await frame.evaluate(() =>
    [...document.querySelectorAll(".rclip[data-marked='1']")].map((c) => c.dataset.group))) === "[]"
    && await app.locator('[data-testid="result-viewer"]').count() === 0);
}
const markChanged = app.locator('[data-testid="mark-changed"]');
check("with a clip whose prompt changed, the bar offers to mark the changed clips",
  /Mark changed clips \(1\)/.test(await markChanged.innerText().catch(() => "")));
await markChanged.click();
await page.waitForTimeout(450);
const marked = () => frame.evaluate(() => [...document.querySelectorAll(".rclip[data-marked='1']")].map((c) => Number(c.dataset.group)));
check("  ... which marks only the changed one, not the ones after it", JSON.stringify(await marked()) === "[2]",
  JSON.stringify(await marked()));
await app.locator(".rclip").nth(0).click();
await page.waitForTimeout(450);
check("clicking a clip marks it too", JSON.stringify(await marked()) === "[1,2]", JSON.stringify(await marked()));
await app.locator(".rclip").nth(0).click();
await page.waitForTimeout(450);
check("  ... and clicking again unmarks it", JSON.stringify(await marked()) === "[2]", JSON.stringify(await marked()));
await app.locator(".rclip").nth(2).dblclick();
await page.waitForTimeout(600);
check("a double-click opens the monitor without marking", JSON.stringify(await marked()) === "[2]"
  && await app.locator('[data-testid="result-viewer"]').count() === 1, JSON.stringify(await marked()));
await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
const regenBtn = app.locator('[data-testid="regen-marked"]');
check("a Regen button appears with the marks", /Regen marked \(1\)/.test(await regenBtn.innerText().catch(() => "")));
check("with a marked clip of one window, there is nothing to split", await app.locator('[data-testid="split-marked"]').count() === 0);
await app.locator('.rclip[data-group="1"]').click({ position: { x: 40, y: 10 } });
await page.waitForTimeout(450);
const splitMarked = app.locator('[data-testid="split-marked"]');
check("mark a clip of several windows and 'Split marked into windows' appears beside Regen",
  /Split marked into windows \(1\)/.test(await splitMarked.innerText().catch(() => "")), await splitMarked.innerText().catch(() => "none"));
{
  const n0 = (await sent()).filter((m) => m.cmd === "render_split").length;
  await splitMarked.click();
  await page.waitForTimeout(800);
  const sp = (await sent()).filter((m) => m.cmd === "render_split").slice(n0);
  check("  ... which splits only the marked clips that have windows to split", sp.length === 1 && sp[0].data.group === 1,
    JSON.stringify(sp.map((x) => x.data.group)));
  await splitIdle();
  check("  ... and clears the marks", JSON.stringify(await marked()) === "[]", JSON.stringify(await marked()));
}
// While a split works, the page says so, and keeps saying so until it is done
{
  await page.evaluate(() => { window.splitHold = true; });
  await app.locator('[data-testid="split-1"]').click();
  await page.waitForTimeout(1600);
  const status = app.locator('[data-testid="split-status"]');
  check("while a clip is being split, the bar says so", await status.count() === 1
    && /Splitting G1/.test(await status.innerText()) && /please wait/.test(await status.innerText()),
    await status.innerText().catch(() => "no status"));
  check("  ... and the clip itself shows it is being split", await app.locator('[data-testid="splitting-1"]').count() === 1
    && /Splitting/.test(await app.locator('[data-testid="splitting-1"]').innerText()));
  await page.screenshot({ path: resolve(dir, "splitting.png"), clip: { x: 0, y: 250, width: 1600, height: 170 } });
  check("  ... it is still showing well after a passing message would have gone", await (async () => {
    await page.waitForTimeout(3200);
    return await status.count() === 1;
  })());
  await page.evaluate(() => { window.splitJob.done = 1; window.splitJob.step = "cutting piece 2 of 2"; window.splitJob.elapsed = 4; });
  await page.waitForTimeout(1000);
  check("  ... and how far it has got", /piece 2 of 2/.test(await status.innerText()), await status.innerText());
  const bar = await page.screenshot({ path: resolve(dir, "splitting-bar.png"), clip: { x: 0, y: 1030, width: 1600, height: 70 } });
  void bar;
  check("  ... Generate, Stitch and the split buttons wait for it",
    await app.getByRole("button", { name: "Generate", exact: true }).isDisabled()
    && await app.locator('[data-testid="stitch"]').isDisabled()
    && await app.locator('.rsplit').count() === 0);
  const n1 = (await sent()).filter((m) => m.cmd === "render_split").length;
  await app.locator('.rclip[data-group="1"]').click({ button: "right", position: { x: 40, y: 10 } });
  await page.waitForTimeout(250);
  check("  ... and a second split cannot be started from the menu", await app.locator('[data-testid="menu-split"]').isDisabled());
  await page.keyboard.press("Escape");
  check("  ... nor was one sent", (await sent()).filter((m) => m.cmd === "render_split").length === n1);
  await page.evaluate(() => { window.splitHold = false; });
  check("once it is done, the notice goes", await splitIdle());
  check("  ... and it says the clip was split", /is now 2 clips/.test(await toast()));
  check("  ... and everything can be used again", !(await app.getByRole("button", { name: "Generate", exact: true }).isDisabled()));
}
// A split that fails says so, and the message stays until it is closed
{
  await page.evaluate(() => { window.splitFail = "not enough disk space"; });
  await app.locator('[data-testid="split-1"]').click();
  await splitIdle();
  await page.waitForTimeout(3200);
  const msg = app.locator('[data-testid="split-msg"]');
  check("a split that fails says why, and it stays on screen", await msg.count() === 1
    && /Could not split G1: not enough disk space/.test(await msg.innerText()), await msg.innerText().catch(() => "no message"));
  await msg.getByRole("button").click();
  await page.waitForTimeout(200);
  check("  ... until it is closed", await msg.count() === 0);
  await page.evaluate(() => { window.splitFail = null; });
}
// A page reloaded during a split picks it up
{
  await page.evaluate(() => {
    window.splitHold = true;
    window.splitJob = { state: "running", group: 1, done: 1, total: 2, step: "cutting piece 2 of 2", elapsed: 9, n: 0 };
    window.renderState = { ...window.renderState, splitting: { ...window.splitJob } };
  });
  await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
  await page.waitForTimeout(1500);
  check("a page that finds a split already going shows it", await app.locator('[data-testid="split-status"]').count() === 1,
    await frame.evaluate(() => document.querySelector(".act")?.textContent || ""));
  await page.evaluate(() => { window.splitHold = false; window.renderState = { ...window.renderState, splitting: null }; });
  check("  ... until it finishes", await splitIdle());
}
await app.locator('.rclip[data-group="2"]').click({ position: { x: 40, y: 10 } });
await page.waitForTimeout(450);
check("there is no seed picker: a regen always uses the render's own seed",
  await app.locator('[data-testid="regen-seed"]').count() === 0);
const gensBefore = (await generates()).length;
await regenBtn.click();
await page.waitForTimeout(1500);
const rg = (await generates()).slice(gensBefore);
check("Regen sends only the marked groups, on the render's own seed",
  rg.length === 1 && JSON.stringify(rg[0].data.regen) === JSON.stringify({ groups: [2], seed: "same" })
  && !rg[0].data.discard_ok && !rg[0].data.resume, JSON.stringify(rg.map((g) => g.data.regen)));
await page.evaluate(() => window.push("gen", { status: "done", logs: [{ level: "ok", msg: "Regenerated group 2." }] }));
await page.waitForTimeout(700);
check("  ... and the marks clear once it is done", JSON.stringify(await marked()) === "[]", JSON.stringify(await marked()));

check("  ... and it says to stitch once you are happy with it",
  await frame.evaluate(() => /press Stitch now/.test(document.body.innerText)));
const stitchBtn = app.locator('[data-testid="stitch"]');
await page.evaluate((st) => { window.renderState = st; }, { ...doneState, stitch_stale: true,
  stitch_why: "clip G2 changed after the last stitch" });
await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
await page.waitForTimeout(800);
check("after a regen the Stitch button says the full video is out of date",
  /Stitch now \(3 clips\)/.test(await stitchBtn.innerText().catch(() => ""))
  && (await stitchBtn.getAttribute("data-stale")) === "1"
  && /G2 changed/.test(await stitchBtn.getAttribute("title") || ""), await stitchBtn.innerText().catch(() => ""));
check("  ... and sits right beside Generate, where it cannot be pushed out of sight",
  await frame.evaluate(() => { const b = [...document.querySelectorAll(".act button")].map((x) => x.textContent);
    return b.findIndex((t) => /^Generate$/.test(t)) + 1 === b.findIndex((t) => /^Stitch/.test(t)); }));
await page.evaluate((st) => { window.renderState = st; }, doneState);
await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
await page.waitForTimeout(800);
check("a Stitch button is there when clips exist", /Stitch \(3\)/.test(await stitchBtn.innerText().catch(() => "")));
await stitchBtn.click();
await page.waitForTimeout(600);
check("  ... and asks Python to join them", (await sent()).some((m) => m.cmd === "stitch"));

// Generate with everything rendered asks before replacing anything
await page.evaluate((st) => { window.renderState = st; }, { ...doneState, kept_groups: 3, recorded_groups: 3,
  clips: doneState.clips.map((c) => ({ ...c, status: "done", why: "" })) });
await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
await page.waitForTimeout(800);
const g0 = (await generates()).length;
await app.locator(".act button", { hasText: /^Generate$/ }).click();
await page.waitForTimeout(400);
check("Generate with every clip rendered asks before replacing them",
  (await app.locator(".sheet.confirm", { hasText: "Render the finished clips again" }).count()) === 1
  && (await generates()).length === g0);
await app.locator(".sheet.confirm button", { hasText: "Cancel" }).click();
await page.waitForTimeout(300);
check("  ... and Cancel replaces nothing", (await generates()).length === g0);
console.log("       screenshot: " + resolve(dir, "results-lane.png"));
await page.evaluate((st) => { window.renderState = st; }, { ...RESUMABLE });
await page.evaluate(() => window.push("gen", { status: "cancelled", logs: [] }));
await page.waitForTimeout(800);
check("with nothing rendered, the lane stays and says how to fill it",
  await frame.evaluate(() => !!document.querySelector(".trk.results")
    && !document.querySelector(".trk.results .rclip")
    && /appears here/.test(document.querySelector('[data-testid="results-empty"]')?.textContent || "")));

// A group finishing is announced by one status frame, and the status box can
// skip it when several arrive together. The revision on the NEXT frame must
// still bring the results track up to date.
await page.evaluate((st) => { window.renderState = st; }, laneState);
const asksBefore = (await sent()).filter((m) => m.cmd === "render_state").length;
await page.evaluate(() => window.push("gen", { status: "running", progress: 0.4, logs: [], render_rev: 101 }));
await page.waitForTimeout(700);
const asksAfter = (await sent()).filter((m) => m.cmd === "render_state").length;
check("a new render revision on any frame refreshes the results track", asksAfter > asksBefore,
  `${asksBefore} -> ${asksAfter}`);
await page.evaluate(() => window.push("gen", { status: "running", progress: 0.5, logs: [], render_rev: 101 }));
await page.waitForTimeout(700);
check("  ... and the same revision again does not ask twice",
  (await sent()).filter((m) => m.cmd === "render_state").length === asksAfter);
await page.evaluate((st) => { window.renderState = st; }, { ...RESUMABLE });
await page.evaluate(() => window.push("gen", { status: "cancelled", logs: [] }));
await page.waitForTimeout(800);

// Discard
await page.evaluate((st) => { window.renderState = st; }, RESUMABLE);
await page.evaluate(() => window.push("gen", { status: "cancelled", logs: [] }));
await page.waitForTimeout(800);
await app.locator('[data-testid="resume-card"] button', { hasText: "Discard" }).click();
await page.waitForTimeout(300);
check("Discard asks first", await app.locator(".sheet.confirm", { hasText: "Discard the unfinished render" }).count() === 1);
await app.locator(".sheet.confirm button", { hasText: /^Discard$/ }).click();
await page.waitForTimeout(800);
check("  ... then tells Python to clear it", (await sent()).some((m) => m.cmd === "render_discard"));
check("  ... and the card and Continue are gone",
  await app.locator('[data-testid="resume-card"]').count() === 0
  && await app.locator('[data-testid="continue-render"]').count() === 0);
// Clearing the timeline clears the results track with it
// A one-window clip whose window was cut in two on the timeline can be split to match
{
  // G2 was rendered as ONE window covering what are now windows 3 and 4 on
  // the timeline, and a regen of it started 4 frames early (so its start is
  // a few frames off the window edge). Python has not been asked again: the
  // record says nothing about splitting -- the page works it out itself.
  const w2 = bands[2].frames + bands[3].frames;
  const c2 = { ...clip(2, 2, 1, "redo", "the windows under group 2 were changed on the timeline"),
    start: starts[2] - 4, frames: w2, frames_got: w2 + 4, windows: [w2] };
  const recut = { ...doneState, clips: [clip(1, 0, 2, "done"), c2,
    { ...clip(3, 4, bands.length - 4, "after", "renders again after group 2") }] };
  await page.evaluate((st) => { window.renderState = st; }, recut);
  await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
  await page.waitForTimeout(900);
  check("a one-window clip whose window was re-cut on the timeline offers Split",
    await app.locator('[data-testid="split-2"]').count() === 1 && await app.locator('[data-testid="split-3"]').count() === 0);
  check("  ... with a line where it would be cut: on the window edge", await frame.evaluate((edge) => {
    const l = document.querySelectorAll('.rclip[data-group="2"] .rwin');
    return l.length === 1 && Math.abs(l[0].getBoundingClientRect().left - edge) <= 2;
  }, bands[3].left), String(bands[3].left));
  await app.locator('.rclip[data-group="2"]').click({ button: "right", position: { x: 20, y: 10 } });
  await page.waitForTimeout(250);
  check("  ... and its menu says it splits at the new windows",
    /Split at the new windows \(2\)/.test(await app.locator('[data-testid="menu-split"]').innerText().catch(() => ""))
    && !(await app.locator('[data-testid="menu-split"]').isDisabled()));
  await page.keyboard.press("Escape");
  const n0 = (await sent()).filter((m) => m.cmd === "render_split").length;
  await app.locator('[data-testid="split-2"]').click();
  await page.waitForTimeout(500);
  const sp = (await sent()).filter((m) => m.cmd === "render_split").slice(n0);
  check("  ... which asks Python to split that clip", sp.length === 1 && sp[0].data.group === 2, JSON.stringify(sp.map((x) => x.data)));
  await splitIdle();
}
await page.evaluate((st) => { window.renderState = st; }, doneState);
await page.evaluate(() => window.push("gen", { status: "done", logs: [] }));
await page.waitForTimeout(800);
check("(clips on the results track before the clear)",
  await frame.evaluate(() => document.querySelectorAll(".trk.results .rclip").length) === 3);
const discBefore = (await sent()).filter((m) => m.cmd === "render_discard").length;
await app.locator(".time .tb button.dg").first().click();
await page.waitForTimeout(300);
const clearSheet = app.locator(".sheet.confirm", { hasText: "Clear the timeline" });
check("Clear says the rendered clips go too",
  /3 rendered clips on the results track are deleted too/.test(await clearSheet.innerText().catch(() => "")),
  await clearSheet.innerText().catch(() => ""));
await app.locator(".sheet.confirm button", { hasText: "Clear timeline and results" }).click();
await page.waitForTimeout(900);
check("  ... then tells Python to delete them",
  (await sent()).filter((m) => m.cmd === "render_discard").length === discBefore + 1);
check("  ... and the results track and the timeline are both empty",
  await frame.evaluate(() => document.querySelectorAll(".trk.results .rclip").length === 0
    && document.querySelectorAll(".seg-c").length === 0));
check("no uncaught errors throughout", errors.length === 0, errors[0]);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} RESUME UI CHECK(S) FAILED`); process.exit(1); }
console.log("ALL RESUME UI CHECKS PASSED");
