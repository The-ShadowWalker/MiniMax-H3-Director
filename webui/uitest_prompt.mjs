/**
 * Which window a prompt is sent to. A shot that runs only a few frames past a
 * window edge -- a boundary placed by eye -- belongs to its own window, not
 * also to the next one. A shot that really runs across windows goes to each.
 *
 *     cd webui && node uitest_prompt.mjs
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "h3d-prompt-")), "prompt.mjs");
const r = await build({ entryPoints: [resolve(HERE, "src/lib/prompt.ts")], bundle: true, platform: "node",
  format: "esm", write: false, logLevel: "silent" });
writeFileSync(out, r.outputFiles[0].text);
const { buildPromptRelay, windowsForSegment } = await import(pathToFileURL(out).href);

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  OK   " : "  FAIL ") + label + (ok || !detail ? "" : "  -- " + detail));
  if (!ok) failures.push(label);
};

const seg = (id, start, length, prompt) => ({ id, track: "video", kind: "text", start, length, prompt, title: id });
const session = (segments) => ({ fps: 24, global_prompt: "", globalEveryWindow: true, hardcuts: "",
  timeline: { segments } });
const W = [{ i: 0, start: 0, end: 120 }, { i: 1, start: 120, end: 240 }];
const relay = (segs) => buildPromptRelay(session(segs), W).windows.map((w) => w.prompt);

// a 10s window cut in two by eye, 4 frames past the end of the first shot
let p = relay([seg("a", 0, 124, "FIRST shot"), seg("b", 124, 116, "SECOND shot")]);
check("a shot that runs 4 frames into the next window is not sent there", !/FIRST/.test(p[1]) && /SECOND/.test(p[1]), p[1]);
check("  ... and stays with its own window", /FIRST/.test(p[0]) && !/SECOND/.test(p[0]), p[0]);
// the other way: the second shot starts a few frames early
p = relay([seg("a", 0, 115, "FIRST shot"), seg("b", 115, 125, "SECOND shot")]);
check("a shot that starts 5 frames before its window is not sent to the one before",
  !/SECOND/.test(p[0]) && /SECOND/.test(p[1]), JSON.stringify(p));
// a shot that really runs across both windows goes to both
p = relay([seg("a", 0, 240, "LONG shot")]);
check("a shot across both windows is sent to both", /LONG/.test(p[0]) && /LONG/.test(p[1]), JSON.stringify(p));
p = relay([seg("a", 60, 120, "MIDDLE shot")]);
check("a shot half in each window is sent to both", /MIDDLE/.test(p[0]) && /MIDDLE/.test(p[1]), JSON.stringify(p));
// two shots inside one window both go to it
p = buildPromptRelay(session([seg("a", 0, 60, "ONE"), seg("b", 60, 60, "TWO")]), W).windows.map((w) => w.prompt);
check("two shots inside one window are both sent to it", /ONE/.test(p[0]) && /TWO/.test(p[0]) && !/ONE|TWO/.test(p[1]), JSON.stringify(p));
check("a short shot half in each window goes to both",
  JSON.stringify(windowsForSegment({ start: 117, length: 8 }, W)) === "[0,1]");
check("a shot 2 frames over the edge goes only to the window it fills",
  JSON.stringify(windowsForSegment({ start: 118, length: 122 }, W)) === "[1]");

console.log();
if (failures.length) { console.log(`${failures.length} PROMPT CHECK(S) FAILED`); process.exit(1); }
console.log("ALL PROMPT CHECKS PASSED");
