/**
 * The Hybrid builder pane, inside a stand-in for Wan2GP.
 *
 * Its folders and models must come from the running Wan2GP, never from a
 * path built into the page. The stand-in answers like a Wan2GP installed on
 * E: with a second model folder on F::
 *
 *   * the pane asks Python for the folders and models as it opens;
 *   * the model lists and "Save to" show THAT install, and the old built-in
 *     D:\Wan2GP\ckpts is nowhere;
 *   * a project saved with the old default is moved to "Wan2GP's model folder";
 *   * Build sends the chosen models and folder, shows progress while it runs
 *     and says where the Hybrid went when it is done.
 *
 *     cd webui && node uitest_builder.mjs
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

const SCAN = {
  roots: ["E:\\AI\\WanGP\\ckpts", "F:\\Models\\H3", "E:\\AI\\WanGP"],
  default_root: "E:\\AI\\WanGP\\ckpts",
  wan2gp_root: "E:\\AI\\WanGP",
  checkpoints: [
    { path: "E:\\AI\\WanGP\\ckpts\\MiniMax-H3-FL2VA_bf16.safetensors", name: "MiniMax-H3-FL2VA_bf16.safetensors", folder: "E:\\AI\\WanGP\\ckpts", kind: "fl2va" },
    { path: "F:\\Models\\H3\\MiniMax-H3-Ref2VA_bf16.safetensors", name: "MiniMax-H3-Ref2VA_bf16.safetensors", folder: "F:\\Models\\H3", kind: "ref2va" },
  ],
  fl2va: "E:\\AI\\WanGP\\ckpts\\MiniMax-H3-FL2VA_bf16.safetensors",
  ref2va: "F:\\Models\\H3\\MiniMax-H3-Ref2VA_bf16.safetensors",
};
// a real project saved by an older version, with the old built-in folder in it
const OLD = {"plugin": "MiniMaxH3HybridAVUniversal", "version": "2.2.0", "project_name": "old project", "pipeline": "Hybrid", "size": "Full 33B", "global_prompt": "", "fps": 24, "duration_sec": 20, "hardcuts": "", "savedAt": "19:27:59", "advanced": {"checkpoint": "MiniMax-H3-Hybrid-BF16-FL2VA-Base-Ref2VA-AdaLN30-49", "resolution": "704x1280", "resolution_category": "720p", "seed": -1, "repeat": 1, "steps": 8, "flowshift": 12, "guidance": 1, "solver": "euler", "cache_type": "", "cache_mult": 0.5, "cache_strength": 0.08, "cache_start": 0, "override_attention": "", "text_encoder": "", "video_vae": "", "priority": "", "loras": [], "loras_mult": "", "start_tau": 0, "guidance_phases": 1, "phase2_noise": 0, "fl2va_guide_mode": "auto", "denoising": 1, "mask_mode": "", "masking_strength": 1, "pdd": true, "sample_solver": "euler", "spatial_upsampling": "lanczos2", "self_refiner_setting": 2}, "refs": {"images": [], "videos": [], "audio": [], "imageMode": "I", "imageDetail": 100, "removeBg": false, "refmods": [], "refmodRetention": 1}, "audio": {"source": "", "controlVideoAudio": "mute"}, "sfx": {"enabled": true, "method": "custom", "prompt": "", "negative": "", "seed": -1, "videoPath": "", "outName": "", "alsoMux": false, "lastAudio": "", "lastMuxed": "", "status": "", "message": "", "no_music": false, "no_speech": false, "no_ambience": false, "no_effects": false}, "exportInclude": {"video": true, "originalMusic": true, "previewMix": true, "sfxStems": false, "sfxCsv": false, "finalMix": false}, "builder": {"fl2va": "MiniMax-H3-FL2VA_bf16", "ref2va": "MiniMax-H3-Ref2VA_bf16", "startBlock": 30, "endBlock": 49, "includeFinal": false, "saveTo": "D:\\Wan2GP\\ckpts", "status": "Blocks 30\u201349 tested: reference identity holds while audio drives lip sync."}, "timeline": {"fps": 24, "durationSec": 20, "slidingWindowSize": 362, "slidingWindowOverlap": 18, "showWindows": true, "snap": true, "allowPastCap": false, "playhead": 40, "segments": [], "manualWindows": true, "windowFrames": [122, 118, 122, 118], "groupsOn": true, "groupWindows": 1}, "lockClipAudio": true, "durationLocked": true, "loopPlayback": true, "autoRenumberRefs": true, "app": "h3_director2", "plugin_version": "1.6.23"};

const dir = mkdtempSync(join(tmpdir(), "h3d-builder-ui-"));
const host = join(dir, "host.html");
writeFileSync(host, `<!doctype html><html><body style="margin:0">
<iframe id="f" src="file://${PAGE}" style="width:1580px;height:1080px;border:0"></iframe>
<script>
  window.sent = [];
  window.job = { state: "idle" };
  window.polls = 0;
  const f = document.getElementById("f");
  const reply = (id, data) => f.contentWindow.postMessage({ source: "h3d2_parent", id, data }, "*");
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.source !== "h3d2_frame") return;
    window.sent.push({ cmd: m.cmd, data: m.data });
    if (!m.id) return;
    if (m.cmd === "builder_scan") return reply(m.id, ${JSON.stringify(SCAN)});
    if (m.cmd === "builder_build") {
      window.job = { state: "running", done: 0, total: 1000, message: "Reading tensors: 0/1,000" };
      return reply(m.id, { ok: true, started: true, output: "E:\\\\AI\\\\WanGP\\\\ckpts\\\\MiniMax-H3-Hybrid.safetensors" });
    }
    if (m.cmd === "builder_state") {
      const j = window.job;
      if (j.state === "running") {
        window.polls += 1;
        j.done = Math.min(1000, j.done + 400);
        j.message = "Reading tensors: " + j.done + "/1,000";
        if (window.polls > 3 && !window.hold) Object.assign(j, { state: "done", result: {
          checkpoint: "E:\\\\AI\\\\WanGP\\\\ckpts\\\\MiniMax-H3-Hybrid-BF16-FL2VA-Base-Ref2VA-AdaLN30-49.safetensors",
          cached: false, definition: "E:\\\\AI\\\\WanGP\\\\finetunes\\\\x.json",
          model_id: "MiniMax-H3-Hybrid-BF16-FL2VA-Base-Ref2VA-AdaLN30-49", recipe: "x", refreshed: true } });
      }
      return reply(m.id, { ...j });
    }
    if (m.cmd === "load_project_json") return reply(m.id, { payload: ${JSON.stringify(OLD)} });
    if (m.cmd === "list_models") return reply(m.id, { models: [{ model_type: "minimax_h3_hybrid", name: "H3 Hybrid" }] });
    if (m.cmd === "render_state") return reply(m.id, { has_record: false, running: false, resumable: false, complete: false });
    if (m.cmd === "job_state") return reply(m.id, { status: "idle", attached: true, log: [], files: [] });
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
const sent = () => page.evaluate(() => window.sent);

await app.locator("button.st", { hasText: "Hybrid builder" }).click();
await page.waitForTimeout(1000);
check("opening the pane asks Wan2GP for its folders and models", (await sent()).some((m) => m.cmd === "builder_scan"));
const pane = app.locator(".pane.on");
const text = await pane.innerText();
check("the old built-in D:\\Wan2GP\\ckpts is nowhere", !/D:\\Wan2GP/.test(text) &&
  !(await app.locator('[data-testid="builder-save-to"] option').allInnerTexts()).some((t) => /D:\\Wan2GP/.test(t)), text);
const fl = await app.locator('[data-testid="builder-fl2va"]').inputValue();
const rf = await app.locator('[data-testid="builder-ref2va"]').inputValue();
check("the FL2VA and Ref2VA models of THIS install are chosen, wherever they are", fl === SCAN.fl2va && rf === SCAN.ref2va, `${fl} | ${rf}`);
const opts = await app.locator('[data-testid="builder-save-to"] option').allInnerTexts();
check("Save to lists this Wan2GP's model folders, its main one first", /Wan2GP's model folder \(E:\\AI\\WanGP\\ckpts\)/.test(opts[0])
  && opts.some((o) => o === "F:\\Models\\H3") && opts.some((o) => /Another folder/.test(o)), JSON.stringify(opts));
check("  ... and a project saved with the old default now uses Wan2GP's model folder",
  await app.locator('[data-testid="builder-save-to"]').inputValue() === "");
check("it says where the Hybrid will go", /saved in E:\\AI\\WanGP\\ckpts/.test(await app.locator('[data-testid="builder-found"]').innerText()));

await page.evaluate(() => { window.hold = true; });
await app.locator('[data-testid="builder-build"]').click();
await page.waitForTimeout(2500);
const b = (await sent()).filter((m) => m.cmd === "builder_build");
check("Build sends the chosen models and the folder", b.length === 1 && b[0].data.fl2va === SCAN.fl2va
  && b[0].data.ref2va === SCAN.ref2va && b[0].data.save_to === "" && b[0].data.start_block === 30, JSON.stringify(b[0]?.data));
check("while it builds, it says so and how far it has got", /Reading tensors/.test(await app.locator('[data-testid="builder-progress"]').innerText().catch(() => "")));
check("  ... and the controls wait", await app.locator('[data-testid="builder-build"]').isDisabled());
await page.evaluate(() => { window.hold = false; });
await page.waitForTimeout(2500);
const done = await app.locator('[data-testid="builder-done"]').innerText().catch(() => "");
check("when it is done it says where the Hybrid went and how it is registered",
  /E:\\AI\\WanGP\\ckpts\\MiniMax-H3-Hybrid/.test(done) && /registered with Wan2GP/.test(done), done);
check("no uncaught errors", errors.length === 0, errors[0]);

await browser.close();
console.log();
if (failures.length) { console.log(`${failures.length} BUILDER UI CHECK(S) FAILED`); process.exit(1); }
console.log("ALL BUILDER UI CHECKS PASSED");
