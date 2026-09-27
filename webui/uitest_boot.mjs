/**
 * The project on disk is never overwritten by something that failed to load.
 *
 * If Wan2GP does not answer the startup load, the UI is showing the demo --
 * and the UI saves whenever the page loses focus. This loads the built UI in
 * a stand-in for Wan2GP whose first load FAILS, then checks that:
 *   * nothing is saved while the project has not loaded, however often the
 *     page loses focus, and the top bar says so;
 *   * the load is tried again by itself, and the real project comes up;
 *   * saving resumes once it has, with the real project.
 *
 *     cd webui && node uitest_boot.mjs
 */
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
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

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const dir = mkdtempSync(join(tmpdir(), "h3d-boot-"));
const host = join(dir, "host.html");
writeFileSync(host, `<!doctype html><html><body style="margin:0">
<iframe id="f" src="file://${PAGE}" style="width:1580px;height:1080px;border:0"></iframe>
<script>
  window.sent = [];
  window.project = window.__project || null;   // what is "on disk"
  window.failLoads = window.__fail || 0;         // how many loads to refuse first
  const f = document.getElementById("f");
  const reply = (id, data, error) => f.contentWindow.postMessage(
    Object.assign({ source: "h3d2_parent", id }, error ? { error } : { data }), "*");
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.source !== "h3d2_frame") return;
    window.sent.push({ cmd: m.cmd, data: m.data });
    if (!m.id) return;
    if (m.cmd === "load_project_json") {
      if (window.failLoads > 0) { window.failLoads -= 1; return reply(m.id, null, "Wan2GP is busy"); }
      return reply(m.id, { payload: window.project });
    }
    if (m.cmd === "save_project_json") { window.project = m.data.payload; return reply(m.id, { ok: true, bytes: 1 }); }
    if (m.cmd === "render_state") return reply(m.id, { has_record: false, running: false, resumable: false, complete: false });
    if (m.cmd === "job_state") return reply(m.id, { status: "idle" });
    reply(m.id, { ok: true });
  });
</script></body></html>`);

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const errors = [];

// 1) A clean start, to get a real project payload saved "to disk".
let page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + host);
await page.waitForTimeout(2500);
let frame = page.frames().find((fr) => fr.url().endsWith("index.html"));
await frame.evaluate(() => window.dispatchEvent(new Event("blur")));
await page.waitForTimeout(800);
const saved = await page.evaluate(() => window.project);
check("with a normal start, leaving the page saves the project", !!saved?.timeline);
const REAL = { ...saved, project_name: "My Real Project", duration_sec: 37 };
await page.close();

// 2) The first load fails.
page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript((p) => { if (window === window.top) { window.__project = p; window.__fail = 1; } }, REAL);
await page.goto("file://" + host);
await page.waitForTimeout(2000);
frame = page.frames().find((fr) => fr.url().endsWith("index.html"));
for (let i = 0; i < 4; i++) {
  await frame.evaluate(() => { window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(150);
}
await page.waitForTimeout(600);
let saves = (await page.evaluate(() => window.sent)).filter((m) => m.cmd === "save_project_json");
check("while the project has not loaded, nothing is saved - however often the page loses focus",
  saves.length === 0, `${saves.length} save(s): ${saves.map((x) => x.data?.payload?.project_name).join(",")}`);
check("the project on disk is untouched", (await page.evaluate(() => window.project?.project_name)) === "My Real Project");
const body1 = await frame.evaluate(() => document.body.innerText);
check("and the top bar says so", await frame.evaluate(() =>
  /NOT SAVING/.test(document.querySelector('[data-testid="not-saving"]')?.textContent || "")), body1.slice(0, 200));

// the retry, a few seconds later
await page.waitForTimeout(6500);
const body2 = await frame.evaluate(() => document.body.innerText);
check("the load is tried again by itself, and the real project comes up", /My Real Project/.test(body2));
check("  ... and the warning goes", await frame.evaluate(() => !document.querySelector('[data-testid="not-saving"]')));
await frame.evaluate(() => window.dispatchEvent(new Event("blur")));
await page.waitForTimeout(900);
saves = (await page.evaluate(() => window.sent)).filter((m) => m.cmd === "save_project_json");
check("saving resumes once it has loaded - with the real project",
  saves.length >= 1 && saves.every((x) => x.data?.payload?.project_name === "My Real Project"),
  saves.map((x) => x.data?.payload?.project_name).join(","));
// 3) The whole path, as in Wan2GP: the real bridge script from plugin.py, the
// real UI in its iframe, and a stand-in Gradio that -- like Gradio -- reads the
// textbox on click and IGNORES a click while the last is still running. The
// startup "ready" is slow to answer, as it is when Wan2GP reads the model.
const { readFileSync } = await import("node:fs");
const pySrc = readFileSync(process.env.PLUGIN_PY || resolve(HERE, "..", "plugin.py"), "utf-8");
const bridgeJs = pySrc.match(/_BRIDGE_JS = r"""([\s\S]*?)"""/)[1];
const host3 = join(dir, "host3.html");
writeFileSync(host3, `<!doctype html><html><body style="margin:0">
<div id="h3d2-host"><iframe id="h3d2-frame" src="file://${PAGE}" style="width:1580px;height:1000px;border:0"></iframe></div>
<div id="h3d2-req"><textarea></textarea></div><div id="h3d2-resp"><textarea></textarea></div><div id="h3d2-go"><button></button></div>
<script>
  window.project = window.__project; window.saves = []; window.ignored = 0; let working = false;
  function python(m) {        // what plugin.py's _on_bridge answers
    const id = m.id || null, d = m.data || {};
    if (m.cmd === "batch") return { cmd: "batch:ok", data: { items: d.items.map(python) }, id };
    if (m.cmd === "ready") return { cmd: "h3_grid", data: {}, id };
    if (m.cmd === "load_project_json") return { cmd: "load_project_json:ok", data: { payload: window.project }, id };
    if (m.cmd === "save_project_json") { window.saves.push(d.payload.project_name); window.project = d.payload;
      return { cmd: "save_project_json:ok", data: { ok: true, bytes: 1 }, id }; }
    if (m.cmd === "render_state") return { cmd: "render_state:ok", data: { has_record: false }, id };
    if (m.cmd === "job_state") return { cmd: "job_state:ok", data: { status: "idle" }, id };
    return { cmd: m.cmd + ":ok", data: { ok: true }, id };
  }
  document.querySelector("#h3d2-go button").addEventListener("click", () => {
    if (working) { window.ignored += 1; return; }          // Gradio, trigger_mode "once"
    const req = JSON.parse(document.querySelector("#h3d2-req textarea").value);
    working = true;
    const slow = req.cmd === "ready" || (req.cmd === "batch" && req.data.items.some((i) => i.cmd === "ready"));
    setTimeout(() => {
      document.querySelector("#h3d2-resp textarea").value = JSON.stringify(python(req));
      working = false;
    }, slow ? 1500 : 250);
  });
</script>
<script>${bridgeJs}</script></body></html>`);
page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript((p) => { if (window === window.top) window.__project = p; }, REAL);
await page.goto("file://" + host3);
await page.waitForTimeout(9000);
const f3 = page.frames().find((fr) => fr.url().endsWith("index.html"));
const body3 = await f3.evaluate(() => document.body.innerText);
check("through the real bridge, your project comes up on open", /My Real Project/.test(body3), body3.slice(0, 160));
check("  ... with no NOT SAVING warning", await f3.evaluate(() => !document.querySelector('[data-testid="not-saving"]')));
await f3.evaluate(() => window.dispatchEvent(new Event("blur")));
await page.waitForTimeout(2500);
const st3 = await page.evaluate(() => ({ saves: window.saves, ignored: window.ignored, name: window.project?.project_name }));
check("  ... the project on disk is still yours after the page loses focus",
  st3.name === "My Real Project" && st3.saves.every((n) => n === "My Real Project"), JSON.stringify(st3));
check("  ... and Gradio never had to ignore a click", st3.ignored === 0, JSON.stringify(st3));

check("no uncaught errors", errors.length === 0, errors[0]);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} BOOT CHECK(S) FAILED`); process.exit(1); }
console.log("ALL BOOT CHECKS PASSED");
