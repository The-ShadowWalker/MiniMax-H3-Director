/**
 * The results viewer, playing real video.
 *
 * Three short clips stand in for finished groups (red, green, blue, each with
 * its own tone). Double-clicking group 2 on the results track must open a
 * window you can move and resize, start playing group 2, and carry straight
 * on into group 3 -- no pause at the join -- the way one file would.
 *
 * The test browser has no H.264, so the stand-ins are VP9/Opus; the viewer
 * does not care what it plays. Needs ffmpeg and playwright.
 *
 *     cd webui && node uitest_viewer.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "..", "assets", "index.html");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIPPED: playwright not installed"); process.exit(0); }
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"].find((p) => existsSync(p));
if (!existsSync(PAGE)) { console.log("SKIPPED: assets/index.html not built yet"); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), "h3d-viewer-"));
const clipsB64 = {};
try {
  for (const [n, colour] of [[1, "red"], [2, "green"], [3, "blue"]]) {
    const out = join(dir, `g${n}.webm`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${colour}:size=320x180:rate=24`,
      "-f", "lavfi", "-i", `sine=frequency=${300 * n}:sample_rate=48000`, "-frames:v", "36", "-t", "1.5",
      "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-shortest", out]);
    clipsB64[`group_w00${n}.mkv`] = readFileSync(out).toString("base64");
  }
} catch (e) { console.log("SKIPPED: ffmpeg could not make the test clips"); process.exit(0); }

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const clip = (group) => ({ group, first_window: group - 1, n_windows: 1, start: (group - 1) * 36, frames: 36,
  frames_got: 36, master: `group_w00${group}.mkv`, bytes: 1000 + group, seed: 7, status: "done", why: "" });
const STATE = { has_record: true, running: false, resumable: false, complete: true,
  clips: [clip(1), clip(2), clip(3)], active: null };

writeFileSync(join(dir, "clips.js"), `window.CLIPS = ${JSON.stringify(clipsB64)};`);
const host = join(dir, "host.html");
writeFileSync(host, `<!doctype html><html><body style="margin:0">
<iframe id="f" src="file://${PAGE}" style="width:1580px;height:1080px;border:0" allow="autoplay"></iframe>
<script src="clips.js"></script>
<script>
  window.sent = [];
  const f = document.getElementById("f");
  const reply = (id, data) => f.contentWindow.postMessage({ source: "h3d2_parent", id, data }, "*");
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.source !== "h3d2_frame") return;
    window.sent.push({ cmd: m.cmd, data: m.data });
    if (!m.id) return;
    if (m.cmd === "render_state") return reply(m.id, ${JSON.stringify(STATE)});
    if (m.cmd === "render_poster") return reply(m.id, { data: "" });
    if (m.cmd === "render_preview") return reply(m.id, m.data.b64
      ? { b64: window.CLIPS[m.data.master], mime: "video/webm" } : { file: "", fileBase: "" });
    if (m.cmd === "load_project_json") return reply(m.id, { payload: null });
    if (m.cmd === "job_state") return reply(m.id, { status: "idle" });
    reply(m.id, { ok: true });
  });
</script></body></html>`);

const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}),
  args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + host);
await page.waitForTimeout(2500);
const frame = page.frames().find((fr) => fr.url().endsWith("index.html"));
const app = page.frameLocator("#f");

const blocks = app.locator(".rclip");
check("three finished groups are on the results track", await blocks.count() === 3);

const frontColour = () => frame.evaluate(() => {
  const v = document.querySelector('[data-testid="result-viewer"] video[data-front="1"]');
  if (!v || v.readyState < 2) return null;
  const c = document.createElement("canvas"); c.width = 8; c.height = 8;
  const g = c.getContext("2d"); g.drawImage(v, 0, 0, 8, 8);
  const d = g.getImageData(4, 4, 1, 1).data;
  return d[0] > 150 ? "red" : d[1] > 90 ? "green" : d[2] > 150 ? "blue" : `rgb(${d[0]},${d[1]},${d[2]})`;
});
const front = () => frame.evaluate(() => {
  const v = document.querySelector('[data-testid="result-viewer"] video[data-front="1"]');
  return v ? { paused: v.paused, t: v.currentTime } : null;
});
const title = () => app.locator('[data-testid="rv-title"]').innerText();

await blocks.nth(1).dblclick();
await page.waitForTimeout(900);
const viewer = app.locator('[data-testid="result-viewer"]');
check("double-clicking a clip opens the results monitor", await viewer.count() === 1);
check("  ... showing that clip", /group 2/.test(await title()), await title());
check("  ... its picture (green)", (await frontColour()) === "green", await frontColour());
check("  ... paused, until the timeline plays", (await front())?.paused === true);
const css = await frame.evaluate(() => getComputedStyle(document.querySelector('[data-testid="result-viewer"]')).resize);
check("the window can be resized", css === "both", css);

// Move it off the timeline by its title bar (so the timeline can be clicked).
const hb = await app.locator('[data-testid="result-viewer"] .monitor-h').boundingBox();
await page.mouse.move(hb.x + 60, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + 60 + 700, hb.y + hb.height / 2 + 260, { steps: 8 });
await page.mouse.up();
const hb2 = await app.locator('[data-testid="result-viewer"] .monitor-h').boundingBox();
check("the window can be moved by its title bar", Math.abs(hb2.x - hb.x - 700) < 4 && Math.abs(hb2.y - hb.y - 260) < 4,
  JSON.stringify({ from: [hb.x, hb.y], to: [hb2.x, hb2.y] }));

// Scrub: click the empty clip-audio lane over group 3.
const b3 = await blocks.nth(2).boundingBox();
const lane = await app.locator('.trk[data-track="clipaudio"]').boundingBox();
await page.mouse.click(b3.x + b3.width / 2, lane.y + lane.height - 4);
await page.waitForTimeout(900);
check("moving the playhead onto group 3 shows group 3", /group 3/.test(await title()), await title());
check("  ... its picture (blue)", (await frontColour()) === "blue", await frontColour());
const f3 = await front();
check("  ... at the playhead's point in the clip", !!f3 && f3.t > 0.4 && f3.t < 1.1, JSON.stringify(f3));

// Play the timeline from late in group 1: the monitor plays and carries on into group 2.
const b1 = await blocks.nth(0).boundingBox();
await page.mouse.click(b1.x + b1.width * 0.8, lane.y + lane.height - 4);
await page.waitForTimeout(700);
check("back on group 1 (red)", (await frontColour()) === "red", await frontColour());
await app.locator(".tb button", { hasText: "Play" }).first().click();
await page.waitForTimeout(250);
check("pressing Play on the timeline plays the monitor", (await front())?.paused === false, JSON.stringify(await front()));
await page.waitForTimeout(1100);
check("  ... and it carries on into group 2 as the playhead crosses", /group 2/.test(await title())
  && (await frontColour()) === "green" && (await front())?.paused === false,
  `${await title()} ${await frontColour()} ${JSON.stringify(await front())}`);
await app.locator(".tb button", { hasText: /Pause|Play/ }).first().click();
await page.waitForTimeout(300);
check("pausing the timeline pauses it", (await front())?.paused === true);

await page.screenshot({ path: join(dir, "viewer.png") });
console.log("       screenshot: " + join(dir, "viewer.png"));
await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
await page.waitForTimeout(300);
check("Escape closes it", await viewer.count() === 0);
check("no uncaught errors", errors.length === 0, errors[0]);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} VIEWER CHECK(S) FAILED`); process.exit(1); }
console.log("ALL VIEWER CHECKS PASSED");
