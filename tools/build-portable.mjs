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
function compileGhidraScripts() {
  const javaDir = process.env.JAVA_HOME || "D:/rea/jdk";
  const javac = join(javaDir, "bin", "javac.exe");
  const ghidraDir = process.env.GHIDRA_INSTALL_DIR || "D:/rea/ghidra";
  if (!existsSync(javac) || !existsSync(ghidraDir)) {
    step("note: javac or Ghidra not found; shipping .class files as-is");
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
    javac,
    [
      "-nowarn", "-proc:none", "-cp", jarList.stdout.trim(),
      "-d", join(STAGE, "tools", "ghidra"),
      join(STAGE, "tools", "ghidra", "ReaDecompileAll.java"),
    ],
    { encoding: "utf8" }
  );
  if (res.status === 0) {
    step("compiled ReaDecompileAll for the package");
  } else {
    step("note: script compile failed; shipping .class files as-is");
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
for (const f of [
  "server.mjs",
  "package.json",
  "启动 REA UI.bat",
  "批量反编译.bat",
  "刷新命令列表.bat",
  "README.md",
]) {
  const src = join(root, f);
  if (existsSync(src)) cpSync(src, join(STAGE, f));
}
cpSync(join(root, "public"), join(STAGE, "public"), { recursive: true });
cpSync(join(root, "tools"), join(STAGE, "tools"), { recursive: true });

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
step("publishing");
try {
  rmSync(OUT, { recursive: true, force: true });
} catch {
  step("note: old package is in use; it will be replaced under a new name");
}
try {
  renameSync(STAGE, OUT);
} catch {
  // A leftover directory (e.g. a running copy) blocks the rename; publish next
  // to it instead so the build is never lost.
  const alt = `${OUT}-${process.pid}`;
  renameSync(STAGE, alt);
  step(`note: published at ${alt} (remove the old copy and rename it manually)`);
}
if (REUSING_SELF) {
  try {
    rmSync(REUSING_SELF, { recursive: true, force: true });
  } catch {}
}

step("done");
console.log(`[green] package ready: ${OUT}`);
