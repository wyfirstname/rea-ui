// Assemble the portable ("green") Windows package.
//
// Layout produced:
//   REA-UI-green/
//     启动 REA UI.bat
//     server.mjs
//     public/            UI assets + generated catalog.json
//     runtime/node.exe   bundled Node, so the target machine needs nothing
//     app/node_modules/  rea-agents and its dependencies
//
// Usage: node tools/build-portable.mjs [--node <path-to-node-dir>]
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outRoot = process.env.PORTABLE_OUT || "E:/AIGC";
const OUT = join(outRoot, "REA-UI-green");

const nodeDirArg = process.argv.includes("--node")
  ? process.argv[process.argv.indexOf("--node") + 1]
  : null;

// A Node Windows zip ships node.exe at the top level of the extracted folder.
// An existing green package also already carries a usable runtime, so reuse it
// instead of requiring the original zip to be present.
const nodeCandidates = [
  nodeDirArg,
  join(OUT, "runtime"),
  join(OUT + ".runtime-src"),
  "C:/Users/82127/AppData/Local/Temp/noderestore/runtime",
  "C:/Users/82127/AppData/Local/Temp/nodezip/node-v24.22.0-win-x64",
  "C:/Users/82127/AppData/Local/Temp/nodezip",
].filter(Boolean);

function findNodeDir() {
  for (const c of nodeCandidates) {
    if (existsSync(join(c, "node.exe"))) return c;
  }
  throw new Error(
    "node.exe not found. Pass --node <dir-containing-node.exe> or extract the Node zip first."
  );
}

const NODE_DIR = findNodeDir();

// When the runtime is reused from the package being rebuilt, keep a copy so the
// cleanup below cannot delete the only node.exe before it is copied back.
const REUSING_SELF =
  resolve(NODE_DIR) === resolve(join(OUT, "runtime")) ? join(OUT + ".runtime-stash") : null;
if (REUSING_SELF) {
  step("reusing runtime from the existing package");
  try {
    rmSync(REUSING_SELF, { recursive: true, force: true });
  } catch {}
  mkdirSync(dirname(REUSING_SELF), { recursive: true });
  cpSync(join(OUT, "runtime"), REUSING_SELF, { recursive: true });
}

function step(msg) {
  console.log(`[green] ${msg}`);
}

// Locate javac and a Ghidra installation for the optional script compile.
//
// The JDK is picked the same way the launcher does it: an inherited JAVA_HOME
// is often a stale Java 8 (or a dead path) that Ghidra rejects, so it is only
// accepted when javac exists and reports version 21 or 25.
function findJdk() {
  const candidates = [
    process.env.JAVA_HOME,
    process.env.JDK_HOME,
    "D:/rea/jdk",
    "C:/Program Files/Java/jdk-21",
    "C:/Program Files/Java/jdk-25",
    "C:/Program Files/Eclipse Adoptium/jdk-21",
  ].filter(Boolean);
  for (const dir of candidates) {
    const javac = join(dir, "bin", "javac.exe");
    const java = join(dir, "bin", "java.exe");
    if (!existsSync(javac) || !existsSync(java)) continue;
    // java -version writes to stderr; match `java version "21.0.12"`.
    const v = spawnSync(java, ["-version"], { encoding: "utf8" });
    const m = /version\s+"?(\d+)/.exec(`${v.stderr || ""}${v.stdout || ""}`);
    if (m && (m[1] === "21" || m[1] === "25")) return dir;
  }
  return null;
}

function compileGhidraScripts() {
  const javaDir = findJdk();
  const ghidraDir = process.env.GHIDRA_INSTALL_DIR || "D:/rea/ghidra";
  const headless = join(ghidraDir, "support", "analyzeHeadless.bat");
  if (!javaDir || !existsSync(headless)) {
    step("note: no JDK 21/25 or Ghidra found; shipping the existing .class as-is");
    return;
  }
  const jarList = spawnSync(
    "bash",
    ["-lc", `find "${ghidraDir}/Ghidra" -name "*.jar" 2>/dev/null | tr '\\n' ';'`],
    { encoding: "utf8" }
  );
  if (jarList.status !== 0 || !jarList.stdout.trim()) {
    step("note: could not enumerate Ghidra jars; shipping .class files as-is");
    return;
  }
  const res = spawnSync(
    join(javaDir, "bin", "javac.exe"),
    [
      "-nowarn", "-proc:none", "-cp", jarList.stdout.trim(),
      "-d", join(STAGE, "tools", "ghidra"),
      join(STAGE, "tools", "ghidra", "ReaDecompileAll.java"),
    ],
    { encoding: "utf8" }
  );
  if (res.status === 0) {
    step(`compiled ReaDecompileAll with ${javaDir}`);
  } else {
    const why = (res.stderr || res.stdout || "").trim().split("\n")[0] || "unknown";
    step(`note: script compile failed (${why}); shipping .class files as-is`);
  }
}

// Build into a fresh staging directory and swap at the end. Removing a live
// package in place fails whenever Windows still holds a handle on it, and a
// half-removed package is worse than a stale one. A unique staging name also
// means no cleanup is required up front.
const STAGE = `${OUT}.build-${process.pid}`;

mkdirSync(STAGE, { recursive: true });

// 1. application code
step("copying application files");
// Windows batch files MUST keep CRLF line endings. cmd.exe resolves
// `goto :label` / `call :label` by byte offset, so an LF-only .bat makes it
// report "找不到指定的批处理标签" and abort the script mid-way — the launcher
// then never reached the line that starts node, and the page was unreachable.
function copyBatchFile(src, dest) {
  const text = readFileSync(src, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  writeFileSync(dest, text);
}
for (const f of [
  "server.mjs",
  "package.json",
  "启动 REA UI.bat",
  "批量反编译.bat",
  "刷新命令列表.bat",
  "README.md",
]) {
  const src = join(root, f);
  if (!existsSync(src)) continue;
  if (f.toLowerCase().endsWith(".bat")) copyBatchFile(src, join(STAGE, f));
  else cpSync(src, join(STAGE, f));
}
cpSync(join(root, "public"), join(STAGE, "public"), { recursive: true });
cpSync(join(root, "tools"), join(STAGE, "tools"), { recursive: true });

// Guard the launcher. It was once fixed only inside the packaged folder, so
// the next build re-copied the broken script from the source tree and shipped
// a package whose browser opened before the server listened ("cannot reach
// this site"). Fail the build instead of shipping that again.
const LAUNCHER = join(STAGE, "启动 REA UI.bat");
if (!existsSync(LAUNCHER)) {
  throw new Error("launcher 启动 REA UI.bat missing from the source tree");
}
const launcherText = readFileSync(LAUNCHER, "utf8");
const cr = (launcherText.match(/\r/g) || []).length;
const lf = (launcherText.match(/\n/g) || []).length;
if (cr !== lf) {
  throw new Error(`launcher has ${cr} CR but ${lf} LF — cmd.exe needs CRLF for goto/call labels`);
}
const launcherMusts = [
  ["findstr /r", "port probe must use findstr /r (find has no regex)"],
  ['find ":%PORT%.*LISTENING"', null], // must NOT be present
  ["REA_UI_OPEN=1", "browser must be opened by server.mjs once listening"],
  [":probe_port", "port probe helper missing"],
];
for (const [needle, why] of launcherMusts) {
  const present = launcherText.includes(needle);
  if (why && !present) throw new Error(`launcher sanity check failed: ${why}`);
  if (!why && present) throw new Error(`launcher sanity check failed: ${needle} is back`);
}
step(`launcher checks passed (CRLF, ${cr} lines)`);

// Blog/announcement tooling is not part of the shipped product and must not
// ride along in the package (nor in the published repository).
for (const f of ["build-blog-html.mjs"]) {
  const p = join(STAGE, "tools", f);
  if (existsSync(p)) rmSync(p, { force: true });
}

// Ghidra loads headless scripts as compiled classes; without the .class the
// batch decompile script fails at runtime. Compile it here when javac and a
// Ghidra tree are available so a source-only checkout still produces a working
// package.
compileGhidraScripts();

// 2. bundled Node runtime
step("copying Node runtime");
const runtime = join(STAGE, "runtime");
if (REUSING_SELF) {
  cpSync(REUSING_SELF, runtime, { recursive: true });
  try {
    rmSync(REUSING_SELF, { recursive: true, force: true });
  } catch {}
} else {
  mkdirSync(runtime, { recursive: true });
  for (const item of ["node.exe", "node_modules", "LICENSE", "README.md"]) {
    const src = join(NODE_DIR, item);
    if (existsSync(src)) cpSync(src, join(runtime, item), { recursive: true });
  }
}

// node.exe alone is enough to run the CLI and the server; the bundled
// node_modules only supplies npm/corepack metadata, which we do not use.
rmSync(join(runtime, "node_modules"), { recursive: true, force: true });

// 3. rea-agents + dependencies
step("copying rea-agents dependencies");
const appDir = join(STAGE, "app");
mkdirSync(appDir, { recursive: true });
cpSync(join(root, "node_modules"), join(appDir, "node_modules"), { recursive: true });

// Trim dev-only noise that bloats the package without being needed at runtime.
const junk = [".cache", ".package-lock.json"];
for (const j of junk) {
  const p = join(appDir, "node_modules", j);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// frida is an optionalDependency of rea-agents and ships ~130 MB of C build
// intermediates that are never loaded at runtime. Dropping it saves a third of
// the package; REA's Frida commands degrade gracefully without it.
const fridaBuild = join(appDir, "node_modules", "frida", "build");
if (existsSync(fridaBuild)) {
  try {
    rmSync(fridaBuild, { recursive: true, force: true });
    step("dropped frida/build (optional native build artifacts)");
  } catch {
    // Never fail the build over an optional optimisation.
    step("note: could not remove frida/build (in use); package will be larger");
  }
}

// README.md ships as a maintained file in the source root; it is copied
// verbatim above so the two never drift apart.

// --- swap staging into place -----------------------------------------
// Publishing by deleting the old tree in place is unreliable on Windows: a
// background scanner (Defender, indexer) or a live handle makes rmSync fail
// with EPERM, and the build then landed on a random "-<pid>" path that nobody
// double-clicks. Move the old tree aside first, put the new one on the
// canonical path, and only then try to delete the leftover.
step("publishing");
let stale = null;
if (existsSync(OUT)) {
  stale = `${OUT}.stale-${process.pid}`;
  try {
    rmSync(stale, { recursive: true, force: true });
  } catch {}
  try {
    renameSync(OUT, stale);
  } catch {
    stale = null;
    try {
      rmSync(OUT, { recursive: true, force: true });
    } catch {}
  }
}
try {
  renameSync(STAGE, OUT);
} catch {
  // Should be unreachable now that the old tree is moved away; keep the
  // fallback so a build is never lost outright.
  const alt = `${OUT}-${process.pid}`;
  renameSync(STAGE, alt);
  step(`note: published at ${alt} (move it to ${OUT} manually)`);
}
if (stale) {
  try {
    rmSync(stale, { recursive: true, force: true });
    step("removed the previous package");
  } catch {
    step(`note: previous package left at ${stale} (in use; delete it manually)`);
  }
}
if (REUSING_SELF) {
  try {
    rmSync(REUSING_SELF, { recursive: true, force: true });
  } catch {}
}

step("done");
console.log(`[green] package ready: ${OUT}`);
