#!/usr/bin/env node
// Decompile selected REA procedures and write the pseudocode to disk.
//
// Ghidra sessions launched through REA are ephemeral by design: the imported
// Program lives in a temporary project that is deleted on close, so no
// decompiled output survives a run unless the caller writes it out. This script
// does that, producing one readable file plus one JSON Evidence file per
// procedure.
//
// Note: REA answers one procedure per process, so this is only practical for a
// handful of functions. To decompile an entire binary use the batch script
// 批量反编译.bat, which runs ReaDecompileAll.java inside a single Ghidra session.
//
// Usage:
//   node tools/decompile-to-files.mjs --target <binary> --out <dir> \
//        --symbols <sym1,sym2,...> [--symbols-file] [--provider ghidra]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REA = join(here, "..", "app", "node_modules", "rea-agents", "scripts", "rea.mjs");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg("target");
const outDir = resolve(arg("out", "./analysis/funcs"));
const provider = arg("provider", "ghidra");
const snapshot = arg("snapshot");

if (!target) {
  console.error("--target is required");
  process.exit(1);
}

function loadSymbols() {
  const spec = arg("symbols");
  if (!spec) return [];
  const raw = process.argv.includes("--symbols-file") ? readFileSync(resolve(spec), "utf8") : spec;
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

// REA returns YAML by default and escapes pseudocode inside a double-quoted
// scalar, so pull that field out and unescape it.
function decompile(symbol) {
  return new Promise((res) => {
    const args = [REA, "function", target, "--procedure", symbol, "--provider", provider];
    if (snapshot) args.push("--snapshot", snapshot);
    const child = spawn(process.execPath, args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => res(out));
    child.on("error", () => res(""));
  });
}

function extractPseudocode(text) {
  const m = text.match(/pseudocode:\s*"([\s\S]*?)"\r?\n/);
  if (!m) return null;
  return m[1]
    .replace(/\\r\\n/g, "\n")
    .replace(/\\t/g, "    ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

const symbols = loadSymbols();
if (!symbols.length) {
  console.error("no symbols given (--symbols <sym1,sym2> or --symbols <file> --symbols-file)");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log(`[decompile] ${symbols.length} procedures -> ${outDir}`);

const index = [];
for (const sym of symbols) {
  process.stdout.write(".");
  const raw = await decompile(sym);
  const pseudo = extractPseudocode(raw);
  if (!pseudo) {
    index.push({ symbol: sym, ok: false, reason: "no pseudocode returned" });
    continue;
  }
  const addr = (raw.match(/procedure:\s*\n\s*address:\s*(0x[0-9a-f]+)/) || [])[1] || null;
  const sig = (raw.match(/signature:\s*(.+)/) || [])[1]?.trim() || null;
  const safe = sym.replace(/[^\w.-]+/g, "_").slice(0, 90);
  const base = join(outDir, `${addr ? addr.replace("0x", "") : "unknown"}_${safe}`);

  writeFileSync(
    `${base}.c`,
    `/* ${sym}\n * ${sig || ""}\n * address: ${addr || "?"}\n * source: ${target}\n * provider: ${provider}\n */\n${pseudo}`,
    "utf8"
  );
  writeFileSync(`${base}.evidence.json`, raw, "utf8");
  index.push({ symbol: sym, ok: true, address: addr, signature: sig, base: `${base}.c` });
}
console.log("\n");

writeFileSync(join(outDir, "index.json"), JSON.stringify({ target, provider, index }, null, 2), "utf8");

const okCount = index.filter((x) => x.ok).length;
console.log(`[decompile] wrote ${okCount}/${symbols.length} procedures`);
for (const e of index) {
  if (e.ok) console.log(`  OK   ${e.address} ${e.symbol}`);
  else console.log(`  FAIL ${e.symbol} (${e.reason})`);
}
