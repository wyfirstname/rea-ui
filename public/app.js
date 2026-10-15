/* REA UI frontend.
 *
 * The command list and every form field are derived from catalog.json, which the
 * build script generates from REA's own --schema output. Nothing about individual
 * commands is hardcoded here, so all 153 stay usable and a REA upgrade surfaces
 * new commands without code changes.
 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  catalog: { commands: [], capabilities: null },
  selected: null,
  fields: { args: {}, options: {} },
  es: null,
  running: false,
  lastResult: null,
  chat: [],
  outTab: "result",
};

// ---------------------------------------------------------------------------
// Command grouping
// ---------------------------------------------------------------------------

// REA command names encode their target domain as a prefix. Grouping by domain
// gives a usable mental model across 153 commands without hand-maintained lists.
const GROUPS = [
  { id: "js", label: "JavaScript / Electron", test: /javascript|electron|web-bundle|export-web-scripts/ },
  { id: "native", label: "原生二进制 / 反汇编", test: /^(analyze|inspect|decompile|function|search|xrefs|trace|instructions|read-bytes|search-bytes|address-to-file|resolve-native|inspect-native|annotate-native|import-reference|macho|swift|interface-builder|keyed-archive|asset-catalog|dylib|pe-resources|load-image)/ },
  { id: "managed", label: ".NET 程序集", test: /managed/ },
  { id: "android", label: "Android / APK", test: /android|apk|adb|flutter|apktool/ },
  { id: "web", label: "网站与浏览器", test: /web|browser|http|network-capture/ },
  { id: "data", label: "数据库 / 数据格式", test: /sqlite|wasm|evm|interface-builder/ },
  { id: "binary", label: "二进制元数据", test: /go-binary|rust-binary|binary-layout|artifact|firmware|packet|signal|crash/ },
  { id: "evidence", label: "证据与视图", test: /evidence|analysis-view|compare|coverage|obligation|doctor|import-/ },
  { id: "tool", label: "工具与配置", test: /^(setup|update|uninstall|capabilities|providers|tools?|rizin|objdump|cutter|gdb|frida)/ },
];

function groupOf(name) {
  for (const g of GROUPS) if (g.test.test(name)) return g;
  return { id: "other", label: "其它" };
}

function renderList(filter = "") {
  const host = $("#cmdList");
  const q = filter.trim().toLowerCase();
  const matched = state.catalog.commands.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.description || "").toLowerCase().includes(q)
  );

  const byGroup = new Map();
  for (const c of matched) {
    const g = groupOf(c.name);
    if (!byGroup.has(g.id)) byGroup.set(g.id, { label: g.label, items: [] });
    byGroup.get(g.id).items.push(c);
  }

  host.innerHTML = "";
  for (const { label, items } of byGroup.values()) {
    const h = document.createElement("div");
    h.className = "group-head";
    h.textContent = `${label} · ${items.length}`;
    host.appendChild(h);
    for (const c of items) {
      const b = document.createElement("button");
      b.className = "cmd" + (state.selected?.name === c.name ? " active" : "");
      b.innerHTML =
        `<div class="cmd-name">${escapeHtml(c.name)}</div>` +
        `<div class="cmd-desc">${escapeHtml(c.description || "")}</div>`;
      b.onclick = () => selectCommand(c.name);
      host.appendChild(b);
    }
  }
  if (!matched.length) {
    host.innerHTML = '<div class="group-head">没有匹配的命令</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------------------------------------------------------------------------
// Schema-driven form
// ---------------------------------------------------------------------------

function fieldInput(key, schema, kind, required) {
  const wrap = document.createElement("div");
  wrap.className = "field" + (schema.type === "boolean" ? " check" : "");

  const id = `${kind}-${key}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = key;
  if (required) {
    const r = document.createElement("span");
    r.className = "req";
    r.textContent = "*";
    label.appendChild(r);
  }

  let input;
  if (schema.enum) {
    input = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = schema.default !== undefined ? `默认 ${schema.default}` : "—";
    input.appendChild(blank);
    for (const opt of schema.enum) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      input.appendChild(o);
    }
    if (schema.default !== undefined) input.value = String(schema.default);
  } else if (schema.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
  } else if (schema.type === "number" || schema.type === "integer") {
    input = document.createElement("input");
    input.type = "number";
    if (schema.minimum !== undefined) input.min = schema.minimum;
    if (schema.maximum !== undefined) input.max = schema.maximum;
    if (schema.default !== undefined) input.value = schema.default;
  } else if (schema.type === "array") {
    input = document.createElement("textarea");
    input.placeholder = "每行一项";
  } else {
    input = document.createElement("input");
    input.type = "text";
    if (schema.default !== undefined) input.value = schema.default;
    // Path-shaped arguments get a placeholder suggesting absolute Windows paths.
    if (/path|file|dir|folder|artifact|binary/i.test(key) && !schema.enum) {
      input.placeholder = "D:\\path\\to\\target";
    }
  }
  input.id = id;

  const commit = () => {
    let v;
    if (input.type === "checkbox") v = input.checked;
    else if (schema.type === "array") {
      v = input.value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!v.length) v = undefined;
    } else if (input.value === "") v = undefined;
    else if (schema.type === "number" || schema.type === "integer") v = Number(input.value);
    else v = input.value;
    state.fields[kind][key] = v;
    updatePreview();
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);

  wrap.appendChild(label);
  wrap.appendChild(input);

  if (schema.default !== undefined && schema.type !== "boolean") {
    const d = document.createElement("div");
    d.className = "opt-default";
    d.textContent = `默认 ${schema.default}`;
    wrap.appendChild(d);
  }
  if (schema.description) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = schema.description;
    wrap.appendChild(h);
  }
  return wrap;
}

function selectCommand(name) {
  const cmd = state.catalog.commands.find((c) => c.name === name);
  if (!cmd) return;
  state.selected = cmd;
  state.fields = { args: {}, options: {} };

  $("#cmdTitle").textContent = name;
  $("#cmdDesc").textContent = cmd.description || "";
  $("#engineBadge").classList.add("hidden");

  const host = $("#formHost");
  host.innerHTML = "";

  const argProps = cmd.args?.properties || {};
  const optProps = cmd.options?.properties || {};
  const required = new Set(cmd.args?.required || []);

  const hasArgs = Object.keys(argProps).length > 0;
  if (hasArgs) {
    const fs = document.createElement("fieldset");
    const lg = document.createElement("legend");
    lg.textContent = "参数";
    fs.appendChild(lg);
    for (const [key, schema] of Object.entries(argProps)) {
      fs.appendChild(fieldInput(key, schema, "args", required.has(key)));
    }
    host.appendChild(fs);
  }

  const optKeys = Object.keys(optProps);
  if (optKeys.length) {
    const fs = document.createElement("fieldset");
    const lg = document.createElement("legend");
    lg.textContent = "选项（可选项，多数有默认值，可留空）";
    fs.appendChild(lg);
    for (const [key, schema] of Object.entries(optProps)) {
      fs.appendChild(fieldInput(key, schema, "options", false));
    }
    host.appendChild(fs);
  }

  if (!hasArgs && !optKeys.length) {
    host.innerHTML = '<div class="empty"><p>该命令无需参数，直接运行即可。</p></div>';
  }

  $("#runBtn").disabled = missingRequired();
  renderList($("#search").value);
  updatePreview();
}

// --- argv preview (mirrors server-side buildArgs) ---
function toKebab(n) {
  return n.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
function missingRequired() {
  const cmd = state.selected;
  if (!cmd) return true;
  const req = cmd.args?.required || [];
  return req.some((k) => {
    const v = state.fields.args[k];
    return v === undefined || v === "" || (Array.isArray(v) && !v.length);
  });
}
function updatePreview() {
  const cmd = state.selected;
  if (!cmd) return;
  const parts = ["rea", cmd.name];
  const argProps = cmd.args?.properties || {};
  for (const k of cmd.args?.required || []) {
    const v = state.fields.args[k];
    if (Array.isArray(v)) parts.push(...v.map(String));
    else if (v !== undefined && v !== "") parts.push(`"${v}"`);
  }
  for (const [k, v] of Object.entries(state.fields.options)) {
    if (v === undefined || v === "") continue;
    const flag = `--${toKebab(k)}`;
    if (typeof v === "boolean") { if (v) parts.push(flag); }
    else if (Array.isArray(v)) { for (const i of v) parts.push(flag, i); }
    else parts.push(flag, `"${v}"`);
  }
  $("#argvPreview").textContent = parts.join(" ");
  $("#runBtn").disabled = missingRequired();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function setStatus(text, cls = "") {
  const chip = $("#statusChip");
  chip.textContent = text;
  chip.className = "chip" + (cls ? " " + cls : "");
}

async function run() {
  if (state.running || !state.selected) return;
  const cmd = state.selected;
  state.running = true;
  state.lastResult = null;
  $("#runBtn").classList.add("hidden");
  $("#stopBtn").classList.remove("hidden");
  $("#progress").classList.remove("hidden");
  $("#progress").textContent = "";
  setStatus("运行中…", "run");
  $("#output").textContent = "";

  state.es = new EventSourcePlaceholder();
  state.es.open({
    command: cmd.name,
    args: state.fields.args,
    options: state.fields.options,
  });
}

class EventSourcePlaceholder {
  constructor() {
    this.controller = new AbortController();
  }
  open(payload) {
    fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: this.controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let data;
            try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }
            this.handle(evLine?.slice(7) || "log", data);
          }
        }
      })
      .catch((e) => {
        if (e.name === "AbortError") setStatus("已停止", "");
        else { setStatus("出错", "err"); $("#output").textContent = String(e.message || e); }
      });
  }
  handle(event, data) {
    if (event === "progress") {
      const p = data.rea_progress || {};
      const pct = p.total ? ` ${Math.round(((p.completed || 0) / p.total) * 100)}%` : "";
      $("#progress").textContent += `${p.message || p.phase || ""}${pct}\n`;
      $("#progress").scrollTop = $("#progress").scrollHeight;
    } else if (event === "result") {
      state.lastResult = data;
      renderOutput();
      // REA reports unavailable providers / unsupported targets as a normal
      // result with a remediation hint and a non-zero exit. Surfacing it here
      // is far more useful than a bare exit code.
      if (data.remediation) {
        addNotice("需要外部引擎", `${data.remediation.action || ""}\n\n${
          data.reason ? "原因：" + data.reason + "\n" : ""
        }${formatRejections(data.details?.rejections)}`);
      }
    } else if (event === "log" || event === "stderr") {
      $("#progress").textContent += (data.line || "") + "\n";
      $("#progress").scrollTop = $("#progress").scrollHeight;
    } else if (event === "failed") {
      $("#output").textContent = String(data.error || "");
      setStatus("出错", "err");
    } else if (event === "done") {
      this.finish(data.exitCode);
    }
  }
  finish(code) {
    state.running = false;
    $("#runBtn").classList.remove("hidden");
    $("#stopBtn").classList.add("hidden");
    if (code === 0) setStatus("完成", "ok");
    else setStatus(`退出码 ${code}`, "err");
  }
  stop() {
    this.controller.abort();
    this.finish("stopped");
  }
}

function formatRejections(rejections) {
  if (!Array.isArray(rejections) || !rejections.length) return "";
  return rejections
    .map((r) => {
      const id = r.provider_id || r.id || "?";
      const reason = r.reason || r.message || "";
      return `  · ${id}: ${reason}`;
    })
    .join("\n");
}

// A dismissible banner above the output area explaining why a run could not
// complete (usually a missing reverse-engineering engine).
function addNotice(title, body) {
  const old = document.querySelector(".notice");
  if (old) old.remove();
  const box = document.createElement("div");
  box.className = "notice";
  box.innerHTML =
    `<div class="notice-head"><strong>${escapeHtml(title)}</strong>` +
    `<button class="ghost small-btn">关闭</button></div>` +
    `<div class="notice-body">${escapeHtml(body)}</div>`;
  box.querySelector("button").onclick = () => box.remove();
  document.querySelector(".output").prepend(box);
}

function renderOutput() {
  const r = state.lastResult;
  if (!r) return;
  if (state.outTab === "result") {
    $("#output").textContent = JSON.stringify(collapse(r), null, 2);
  } else if (state.outTab === "evidence") {
    $("#output").textContent = extractEvidence(r);
  } else {
    $("#output").textContent = JSON.stringify(r, null, 2);
  }
}

// Keep the default view readable: REA envelopes are large, so show the shape
// with long arrays elided rather than dumping hundreds of thousands of lines.
function collapse(obj, depth = 0) {
  if (Array.isArray(obj)) {
    if (obj.length > 12 && depth > 1) {
      return [
        ...obj.slice(0, 6).map((v) => collapse(v, depth + 1)),
        `… 共 ${obj.length} 项，已省略 ${obj.length - 12} 项 …`,
        ...obj.slice(-6).map((v) => collapse(v, depth + 1)),
      ];
    }
    return obj.map((v) => collapse(v, depth + 1));
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > 400) {
        out[k] = v.slice(0, 400) + `… (${v.length} 字符)`;
      } else {
        out[k] = collapse(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

function extractEvidence(obj) {
  const lines = [];
  const walk = (o, path) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (/evidence|provenance|source|reference|citation|digest|sha256|confidence/i.test(k)) {
        lines.push(`\n### ${p}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
      }
      if (typeof v === "object" && v !== null && depthOf(p) < 4) walk(v, p);
    }
  };
  const depthOf = (p) => p.split(".").length;
  walk(obj, "");
  return lines.length
    ? lines.join("\n")
    : "本次结果中没有独立的 evidence 字段。可切到「原始输出」查看完整 JSON。";
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const cfg = {
  baseUrl: localStorage.getItem("rea.baseUrl") || "https://api.openai.com/v1",
  apiKey: localStorage.getItem("rea.apiKey") || "",
  model: localStorage.getItem("rea.model") || "gpt-4o-mini",
};

function addMsg(who, text, isError = false) {
  const div = document.createElement("div");
  div.className = "msg " + who + (isError ? " error" : "");
  // Render fenced rea blocks distinctly so commands are visually obvious.
  const parts = String(text).split(/```rea\n([\s\S]*?)```/);
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("code");
      pre.className = "cmdblock";
      pre.textContent = p.trim();
      div.appendChild(pre);
    } else if (p.trim()) {
      div.appendChild(document.createTextNode(p));
    }
  });
  $("#chatLog").appendChild(div);
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  return div;
}

async function sendChat() {
  const text = $("#chatText").value.trim();
  if (!text) return;
  $("#chatText").value = "";
  addMsg("user", text);
  state.chat.push({ role: "user", content: text });

  const pending = addMsg("assistant", "思考中…");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.chat, ...cfg }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pending.remove();
    addMsg("assistant", data.reply);
    state.chat.push({ role: "assistant", content: data.reply });
  } catch (e) {
    pending.remove();
    addMsg("error", String(e.message || e), true);
  }
}

// ---------------------------------------------------------------------------
// Environment view
// ---------------------------------------------------------------------------

async function loadEnv() {
  const host = $("#envBody");
  host.innerHTML = '<p class="muted">检测中…</p>';
  try {
    const [env, prov] = await Promise.all([
      fetch("/api/env").then((r) => r.json()),
      fetch("/api/providers").then((r) => r.json()),
    ]);

    const parts = [];
    parts.push(`<div class="prov"><div class="prov-head">
      <span class="prov-name">运行时</span>
      <span class="prov-id">${escapeHtml(env.node)} · ${escapeHtml(env.platform)} · pid ${env.pid}</span>
    </div>
    <div class="prov-lim">rea-agents：${escapeHtml(env.reaBin || "未找到")}</div></div>`);

    const cap = state.catalog.capabilities;
    if (cap?.capabilities) {
      parts.push(`<h3 style="font-size:13px;font-weight:500;margin:16px 0 8px">能力清单</h3>`);
      for (const group of cap.capabilities) {
        const anyOn = group.groups?.some((g) => g.available);
        parts.push(`<div class="prov">
          <div class="prov-head">
            <span class="prov-name">${escapeHtml(group.provider?.name || group.provider?.id || "")}</span>
            <span class="prov-id">${escapeHtml(group.provider?.id || "")}</span>
            <span class="badge ${anyOn ? "ok" : "warn"}">${anyOn ? "可用" : "不可用"}</span>
          </div>
          ${(group.shared_limitations || []).map((l) => `<div class="prov-lim">${escapeHtml(l)}</div>`).join("")}
          <div class="ops">${(group.groups || [])
            .map(
              (g) =>
                g.operations
                  .map(
                    (op) =>
                      `<span class="op ${g.available ? "on" : "off"}" title="${escapeHtml(g.reason || "")}">${escapeHtml(op)}</span>`
                  )
                  .join("")
            )
            .join("")}</div>
        </div>`);
      }
    }
    if (prov?.data) {
      parts.push(`<div class="prov"><div class="prov-head"><span class="prov-name">providers 命令输出</span></div>
        <pre class="out-body" style="max-height:300px">${escapeHtml(JSON.stringify(prov.data, null, 2).slice(0, 6000))}</pre></div>`);
    }
    host.innerHTML = parts.join("");
  } catch (e) {
    host.innerHTML = `<p class="muted">${escapeHtml(String(e.message || e))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    state.catalog = await fetch("/api/catalog").then((r) => r.json());
  } catch {
    state.catalog = { commands: [], capabilities: null };
  }
  const n = state.catalog.commands?.length || 0;
  $("#catalogMeta").textContent = `${n} 个命令`;
  renderList();

  try {
    const env = await fetch("/api/env").then((r) => r.json());
    $("#reaStatus").className = "dot " + (env.reaAvailable ? "ok" : "err");
    $("#reaStatusText").textContent = env.reaAvailable ? `REA 就绪 · Node ${env.node}` : "REA 未找到";
  } catch {
    $("#reaStatusText").textContent = "后端未连接";
  }
}

// events
$("#search").addEventListener("input", (e) => renderList(e.target.value));
$("#runBtn").addEventListener("click", run);
$("#stopBtn").addEventListener("click", () => state.es?.stop());
$("#copyBtn").addEventListener("click", async () => {
  if (!state.lastResult) return;
  await navigator.clipboard.writeText(JSON.stringify(state.lastResult, null, 2));
  $("#copyBtn").textContent = "已复制";
  setTimeout(() => ($("#copyBtn").textContent = "复制结果"), 1200);
});
$("#saveBtn").addEventListener("click", () => {
  if (!state.lastResult) return;
  const blob = new Blob([JSON.stringify(state.lastResult, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rea-${state.selected?.name || "result"}-${Date.now()}.json`;
  a.click();
});
$$(".out-tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".out-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    state.outTab = t.dataset.out;
    renderOutput();
  })
);
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    t.classList.add("active");
    $("#view-" + t.dataset.view).classList.add("active");
    if (t.dataset.view === "env") loadEnv();
  })
);
$("#sendBtn").addEventListener("click", sendChat);
$("#chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$("#clearChat").addEventListener("click", () => {
  state.chat = [];
  $("#chatLog").innerHTML = "";
});
$("#refreshEnv").addEventListener("click", loadEnv);
$("#cfgBtn").addEventListener("click", () => {
  $("#cfgBase").value = cfg.baseUrl;
  $("#cfgKey").value = cfg.apiKey;
  $("#cfgModel").value = cfg.model;
  $("#cfgModal").classList.remove("hidden");
});
$("#cfgCancel").addEventListener("click", () => $("#cfgModal").classList.add("hidden"));
$("#cfgSave").addEventListener("click", () => {
  cfg.baseUrl = $("#cfgBase").value.trim() || cfg.baseUrl;
  cfg.apiKey = $("#cfgKey").value.trim();
  cfg.model = $("#cfgModel").value.trim() || cfg.model;
  localStorage.setItem("rea.baseUrl", cfg.baseUrl);
  localStorage.setItem("rea.apiKey", cfg.apiKey);
  localStorage.setItem("rea.model", cfg.model);
  $("#cfgModal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && state.selected) {
    e.preventDefault();
    run();
  }
  if (e.key === "Escape") $("#cfgModal").classList.add("hidden");
});

boot();
