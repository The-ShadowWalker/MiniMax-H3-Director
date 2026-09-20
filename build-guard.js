/* Build guard.
   1) required symbols must still exist (a bulk edit once deleted addFiles)
   2) every JSX component used must be imported or defined locally
      (esbuild treats unknown JSX names as globals, so "PromptBox is not
       defined" only surfaced at runtime as a blank panel) */
const fs = require("fs"), path = require("path");
const { execSync } = require("child_process");

// The guard reads webui/src regardless of where it was started from. Run from
// the repo root it used to hand tsc no project at all, which prints the help
// text and exits non-zero -- a "failure" that says nothing about the code.
const WEBUI = fs.existsSync(path.join(__dirname, "webui", "tsconfig.json"))
  ? path.join(__dirname, "webui")
  : __dirname;
process.chdir(WEBUI);

// A real typecheck. esbuild does not scope-check, so "sfx is not defined" and
// "PromptBox is not defined" both built cleanly and blanked the app at runtime.
try {
  execSync("npx tsc --noEmit", { stdio: "pipe" });
  console.log("typecheck: clean");
} catch (e) {
  console.error(String(e.stdout || e.message));
  console.error("GUARD FAILED: typecheck errors above");
  process.exit(1);
}

const need = {
  "src/components/Timeline.tsx": ["const addFiles", "const trackAt", "const onDrop",
                                  "const ticks", "registerMedia(file)", "onDoubleClick"],
  "src/lib/audio.ts":            ["export function startAudio", "export function unlockAudio"],
  "src/lib/media.ts":            ["export async function registerMedia", "export function hydrateMedia"],
  "src/lib/session.ts":          ["numbering_offset", "auto_renumber_refs"],
  "src/lib/store.ts":            ["previewSchedule", "applyToGenerator", "togglePlay"],
};
let bad = 0;
for (const [f, syms] of Object.entries(need)) {
  const src = fs.readFileSync(f, "utf8");
  for (const sym of syms) if (!src.includes(sym)) { console.error(`  MISSING SYMBOL  ${sym}  (${f})`); bad++; }
}

const HTML = new Set(["Fragment"]);
for (const f of fs.readdirSync("src/components").filter((x) => x.endsWith(".tsx"))) {
  const file = path.join("src/components", f);
  const src = fs.readFileSync(file, "utf8");
  // Only real JSX: "<Name" preceded by ( { > or whitespace at a JSX position,
  // never generics like useRef<HTMLDivElement>(null).
  const stripped = src
    // Comments are prose, not code. Writing "a bare <T>" in one used to be
    // reported as an undefined component.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/useRef<[^>]*>/g, "useRef")
    .replace(/useState<[^>]*>/g, "useState")
    .replace(/\bas\s+[A-Za-z0-9_.<>[\]| ]+/g, "")
    .replace(/:\s*[A-Za-z0-9_.]+<[^>]*>/g, "")
    .replace(/request<[^>]*>/g, "request");
  const used = new Set([...stripped.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)]
    .map((m) => m[1])
    .filter((n) => !/^HTML|^SVG$|^Element$|^Event$|^Node$/.test(n)));
  const imported = new Set();
  for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))[^;]*;/g)) {
    if (m[1]) m[1].split(",").forEach((x) => imported.add(x.trim().split(/\s+as\s+/).pop().trim()));
    if (m[2]) imported.add(m[2].trim());
  }
  for (const m of src.matchAll(/(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g)) imported.add(m[1]);
  for (const u of used) {
    if (!imported.has(u) && !HTML.has(u)) { console.error(`  UNDEFINED JSX   <${u}>  (${file})`); bad++; }
  }
}

console.log(bad ? `\nGUARD FAILED: ${bad} problem(s)` : "guard: symbols present, all JSX components resolved");
process.exit(bad ? 1 : 0);
