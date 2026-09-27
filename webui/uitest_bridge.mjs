/**
 * The Wan2GP-side bridge, under load.
 *
 * Every request from the UI travels through ONE hidden Gradio textbox and ONE
 * button. This runs the real bridge script (read out of plugin.py) against a
 * stand-in for those controls that behaves like Gradio: it reads the textbox
 * when the button is clicked, answers one request at a time, and takes a
 * variable time to do it. Then the UI fires a burst of requests at once, the
 * way it does at startup, and every one of them must come back answered --
 * with its OWN answer.
 *
 *     cd webui && node uitest_bridge.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIPPED: playwright not installed"); process.exit(0); }
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"].find((p) => existsSync(p));

const src = readFileSync(process.env.PLUGIN_PY || resolve(HERE, "..", "plugin.py"), "utf-8");
const m = src.match(/_BRIDGE_JS = r"""([\s\S]*?)"""/);
if (!m) { console.log("FAIL: _BRIDGE_JS not found in plugin.py"); process.exit(1); }

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const N = 12;
const frameHtml = `<script>
  window.got = [];
  addEventListener("message", (e) => { if (e.data && e.data.source === "h3d2_parent" && e.data.id) got.push(e.data); });
  window.burst = (withReady) => {
    if (withReady) parent.postMessage({ source: "h3d2_frame", cmd: "ready", data: {} }, "*");
    for (let i = 0; i < ${N}; i++) {
      parent.postMessage({ source: "h3d2_frame", cmd: "echo", data: { n: i }, id: "q" + i }, "*");
      if (i % 4 === 1) parent.postMessage({ source: "h3d2_frame", cmd: "log", data: { message: "fire and forget " + i } }, "*");
    }
  };
</script>`;

const dir = mkdtempSync(join(tmpdir(), "h3d-bridge-"));
const host = join(dir, "host.html");
writeFileSync(host, `<!doctype html><html><body>
<div id="h3d2-host"></div>
<iframe id="h3d2-frame" srcdoc='${frameHtml.replace(/'/g, "&#39;")}'></iframe>
<div id="h3d2-req"><textarea></textarea></div>
<div id="h3d2-resp"><textarea></textarea></div>
<div id="h3d2-go"><button></button></div>
<script>
  // Gradio, as far as the bridge can tell: the textbox is read when the button
  // is clicked, and -- trigger_mode "once", the default for clicks -- a click
  // that arrives while the previous one is still being handled is IGNORED.
  window.clicked = []; window.ignored = [];
  const queue = []; let working = false;
  function serve() {
    if (working || !queue.length) return;
    working = true;
    const raw = queue.shift();
    const slow = JSON.parse(raw).cmd === "ready";
    setTimeout(() => {
      const req = JSON.parse(raw);
      const one = (r) => ({ cmd: r.cmd + ":ok", data: { echo: r.data }, id: r.id || null });
      // As plugin.py answers a batch: each request its own answer, one reply.
      document.querySelector("#h3d2-resp textarea").value = JSON.stringify(req.cmd === "batch"
        ? { cmd: "batch:ok", data: { items: req.data.items.map(one) }, id: req.id }
        : one(req));
      working = false; serve();
    }, slow ? 900 : window.SLOW ? 400 : 30 + Math.random() * 220);
  }
  document.querySelector("#h3d2-go button").addEventListener("click", () => {
    const raw = document.querySelector("#h3d2-req textarea").value;
    if (working) { ignored.push(raw); return; }
    clicked.push(raw); queue.push(raw); serve();
  });
</script>
<script>${m[1]}</script>
</body></html>`);

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + host);
await page.waitForTimeout(600);
const frame = page.frames().find((f) => f !== page.mainFrame());
// Startup, as the UI does it: "ready" (slow to answer, and nobody waits on
// it), and a moment later the project load and the rest.
await frame.evaluate(() => { parent.postMessage({ source: "h3d2_frame", cmd: "ready", data: {} }, "*"); });
await page.waitForTimeout(450);
await frame.evaluate(() => window.burst(false));
await page.waitForTimeout(9000);

// Only the UI's own requests (q*): the bridge now tags every other message
// with an id of its own, so it can tell when that click has been answered.
const got = (await frame.evaluate(() => window.got)).filter((g) => /^q\d+$/.test(g.id));
// Unpack batches: what matters is which REQUESTS reached Python, and how often.
const clicks = await page.evaluate(() => window.clicked.map((r) => JSON.parse(r)));
const clicked = clicks.flatMap((c) => (c.cmd === "batch" ? c.data.items : [c]));
const ids = new Set(got.map((g) => g.id));
check(`all ${N} requests fired together are answered`, ids.size === N,
  `${ids.size} answered: ${[...ids].sort().join(",")}`);
check("each with its own answer", got.every((g) => g.data && g.data.echo && `q${g.data.echo.n}` === g.id),
  JSON.stringify(got.slice(0, 3)));
const qs = clicked.filter((c) => /^q\d+$/.test(c.id || "")).map((c) => c.id);
check("no request was sent twice", qs.length === N && new Set(qs).size === N, `${qs.length} sent, ${new Set(qs).size} distinct`);
const wantLogs = [...Array(N).keys()].filter((i) => i % 4 === 1).length;
check("fire-and-forget messages still go through, once each",
  clicked.filter((c) => c.cmd === "log").length === wantLogs,
  JSON.stringify(clicked.filter((c) => c.cmd === "log").map((c) => c.data.message)));
check("no click is ever made while the last one is still being handled",
  (await page.evaluate(() => window.ignored.length)) === 0,
  await page.evaluate(() => window.ignored.map((r) => JSON.parse(r).cmd).join(",")));
check("no errors", errors.length === 0, errors[0]);

// Speed: a slow Gradio (0.4s per answer) and a startup-sized burst. One at a
// time that is five seconds before the last answer -- long enough for the
// project load to time out. Batched it is a round trip or two.
await page.evaluate(() => { window.SLOW = true; window.clicked = []; });
await frame.evaluate((n) => { window.got = []; window.t0 = performance.now(); window.burst();
  window.done = new Promise((res) => { const iv = setInterval(() => {
    if (new Set(window.got.filter((g) => /^q\d+$/.test(g.id)).map((g) => g.id)).size >= n) { clearInterval(iv); res(performance.now() - window.t0); } }, 20); }); }, N);
const ms = await frame.evaluate(() => Promise.race([window.done, new Promise((r) => setTimeout(() => r(99999), 15000))]));
const trips = (await page.evaluate(() => window.clicked.length));
check(`a burst of ${N} is answered in a few round trips, not ${N} (${trips} trips, ${Math.round(ms)} ms)`,
  ms < 2500 && trips <= 4, `${trips} trips, ${Math.round(ms)} ms`);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} BRIDGE CHECK(S) FAILED`); process.exit(1); }
console.log("ALL BRIDGE CHECKS PASSED");
