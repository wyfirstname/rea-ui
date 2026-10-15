// Build a browsable index (README.md + index.json) from a decompile-all output
// directory produced by ReaDecompileAll.java.
//
// Usage: node tools/build-index.mjs --dir <decompile-output-dir>

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = resolve(arg("dir"));
if (!existsSync(dir)) {
  console.error("no such directory: " + dir);
  process.exit(1);
}

const files = readdirSync(dir);
const entries = [];

for (const f of files) {
  if (!f.endsWith(".c")) continue;
  const full = join(dir, f);
  const text = readFileSync(full, "utf8");
  const mAddr = (text.match(/address:\s*0x([0-9a-fA-F]+)/) || [])[1] || "";
  const mSig = (text.match(/^\s*\*\s*(.+)$/m) || [])[1] || "";
  const mName = (text.match(/^\/\*\s*(.+)$/m) || [])[1] || "";
  // Ghidra prints "undefined <type>" when the PDB supplies no return type; keep
  // the body but drop the noisy prefix in the table.
  const sig = mSig.trim().replace(/^undefined\s+/, "");
  let size = 0;
  try {
    size = statSync(full).size;
  } catch {}
  const stem = f.replace(/\.c$/, "");
  entries.push({
    name: mName.trim(),
    signature: sig,
    address: mAddr ? "0x" + mAddr : "",
    bytes: size,
    c: stem + ".c",
    asm: existsSync(join(dir, stem + ".asm")) ? stem + ".asm" : null,
    decompiled: !text.includes("no pseudocode returned"),
  });
}

entries.sort((a, b) => (a.address || "").localeCompare(b.address || ""));

writeFileSync(
  join(dir, "index.json"),
  JSON.stringify({ directory: dir, count: entries.length, entries }, null, 2),
  "utf8"
);

const lines = [
  "# 反编译产物索引",
  "",
  "由 Ghidra 12.1.4 在单次会话中批量生成（REA 6.5.0 驱动）。",
  "",
  "每个函数两个文件：`.c` 为反编译伪代码，`.asm` 为反汇编指令。",
  "",
  "> 这些是**反编译伪代码，不是原始源码**。类型与变量名由反编译器推断，可能与原始定义有偏差。",
  "",
  "共 " + entries.length + " 个函数。",
  "",
  "| 地址 | 名称 | 签名 | 产物 |",
  "|---|---|---|---|",
];
for (const e of entries) {
  const links = e.decompiled
    ? "[c](" + e.c + ")" + (e.asm ? " · [asm](" + e.asm + ")" : "")
    : "伪代码缺失";
  lines.push(
    "| `" + e.address + "` | `" + e.name.replace(/\|/g, "\\|") + "` | "
    + e.signature.replace(/\|/g, "\\|") + " | " + links + " |"
  );
}
writeFileSync(join(dir, "README.md"), lines.join("\n") + "\n", "utf8");

console.log("indexed " + entries.length + " functions -> " + dir);
