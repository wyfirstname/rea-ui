// Generate a machine-readable catalog of every REA CLI command by driving the
// real CLI's own introspection flags (--llms, --schema, capabilities --json).
// Output: rea-ui/public/catalog.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Source checkout: tools/ -> ../node_modules. Packaged build: tools/ -> ../app/node_modules.
// REA_BIN overrides both.
function resolveRea() {
  const override = process.env.REA_BIN;
  const candidates = [
    override,
    resolve(here, "..", "app", "node_modules", "rea-agents", "scripts", "rea.mjs"),
    resolve(here, "..", "node_modules", "rea-agents", "scripts", "rea.mjs"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("rea-agents not found. Set REA_BIN to its scripts/rea.mjs path.");
}

const REA = resolveRea();

function run(args, timeout = 60000) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [REA, ...args], {
      cwd: here,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      p.kill();
      res({ code: -1, out, err: "timeout" });
    }, timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
  });
}

// The --llms manifest is a markdown table: | `rea cmd <args>` | description |
// It is the only machine-readable source of per-command descriptions; --schema
// carries only args/options, so both sources are needed.
async function commandDescriptions() {
  const { out } = await run(["--llms"], 120000);
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`rea\s+([a-z0-9-]+)[^`]*`\s*\|\s*([^|]*?)\s*\|/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

async function schemaFor(name) {
  // --format json is required: REA emits YAML for some commands and JSON for
  // others when --schema is used, depending on the command's declared format.
  const { out, code } = await run([name, "--schema", "--format", "json"], 45000);
  if (code !== 0 || !out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const t0 = Date.now();
const descriptions = await commandDescriptions();
const names = [...descriptions.keys()];
console.log(`[catalog] discovered ${names.length} commands`);

const schemas = await pool(names, 10, async (name) => {
  const schema = await schemaFor(name);
  process.stdout.write(schema ? "." : "x");
  return { name, schema };
});
console.log("\n");

const commands = schemas
  .filter((s) => s.schema)
  .map((s) => ({
    name: s.name,
    description: descriptions.get(s.name) || "",
    args: s.schema.args || null,
    options: s.schema.options || null,
  }));

const capabilitiesRaw = await run(["capabilities", "--json"], 60000);
let capabilities = null;
try {
  capabilities = JSON.parse(capabilitiesRaw.out);
} catch {}

const catalog = {
  generatedAt: new Date().toISOString(),
  generator: "rea-ui catalog builder",
  commandCount: commands.length,
  commands,
  capabilities,
};

const outPath = process.env.CATALOG_OUT
  ? resolve(process.env.CATALOG_OUT)
  : resolve(here, "catalog.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(catalog, null, 2), "utf8");

console.log(`[catalog] wrote ${commands.length} commands -> ${outPath}`);
console.log(`[catalog] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
