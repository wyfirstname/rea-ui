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
  runId: null,
  startedAt: null,
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
  // Mirror the server: every positional, required or optional, is emitted in
  // schema order (decompile/function/xrefs take an optional [address]).
  const argKeys = Object.keys(argProps);
  for (const k of argKeys) {
    const v = state.fields.args[k];
    if (Array.isArray(v)) parts.push(...v.map(String));
    else if (v !== undefined && v !== "") parts.push(`"${v}"`);
  }
  for (const [k, v] of Object.entries(state.fields.options)) {
    if (v === undefined || v === "") continue;
    const flag = `--${toKebab(k)}`;
    if (typeof v === "boolean") { if (v) parts.push(flag); }
    else if (Array.isArray(v)) { for (const i of v) parts.push(`${flag}=${i}`); }
    else parts.push(`${flag}=${v}`);
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

// ---------------------------------------------------------------------------
// Progress panel
// ---------------------------------------------------------------------------

// Stages are reported by the server from real signals (it polls its own child
// process tree for the Ghidra java.exe), so the panel never shows a fabricated
// percentage. A local 1s timer keeps the clock moving between server ticks.
const fmtElapsed = (ms) => {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
};

let elapsedTimer = null;

function startElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    if (!state.running || !state.startedAt) return;
    const text = fmtElapsed(Date.now() - state.startedAt);
    $("#pbTime").textContent = text;
    // Keep the status chip in step with the card clock; server ticks alone
    // would let it lag up to 3 seconds behind.
    setStatus(`运行中 ${text}`, "run");
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function resetProgressBox() {
  const box = $("#progressBox");
  box.classList.remove("hidden", "done", "cancelled");
  $("#pbStage").textContent = "准备中…";
  $("#pbTime").textContent = "00:00";
  $("#pbDetail").textContent = "正在启动 REA 进程…";
  const fill = $("#pbFill");
  fill.className = "pb-fill indeterminate";
  fill.style.width = "";
  const log = $("#progress");
  log.textContent = "";
  log.classList.add("hidden");
  $("#pbToggle").textContent = "详情";
}

function setStageText(stage, detail) {
  if (stage) $("#pbStage").textContent = stage;
  if (detail) $("#pbDetail").textContent = detail;
}

function appendLog(line) {
  const log = $("#progress");
  if (!line) return;
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
}

function setProgressBar(percent) {
  const fill = $("#pbFill");
  if (percent == null || Number.isNaN(percent)) {
    fill.className = "pb-fill indeterminate";
    fill.style.width = "";
    return;
  }
  fill.className = "pb-fill determinate";
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function run() {
  if (state.running || !state.selected) return;
  const cmd = state.selected;
  state.running = true;
  state.lastResult = null;
  state.runId = null;
  state.startedAt = Date.now();
  $("#runBtn").classList.add("hidden");
  $("#stopBtn").classList.remove("hidden");
  $("#output").textContent = "";
  resetProgressBox();
  setStatus("运行中 00:00", "run");
  startElapsedTimer();

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
    if (event === "started") {
      // Keep the run id so 取消 can reach this exact child process.
      state.runId = data.runId;
    } else if (event === "stage") {
      // Server-observed phase: REA child -> Ghidra java.exe -> result assembly.
      setStageText(data.stage, data.detail);
      if (typeof data.elapsedMs === "number") {
        $("#pbTime").textContent = fmtElapsed(data.elapsedMs);
      }
      appendLog(`[阶段] ${data.stage}${data.detail ? " — " + data.detail : ""}`);
    } else if (event === "progress") {
      const p = data.rea_progress || {};
      const pct = p.total ? Math.round(((p.completed || 0) / p.total) * 100) : null;
      setProgressBar(pct);
      const label = p.message || p.phase || "";
      if (label) setStageText(label, pct == null ? $("#pbDetail").textContent : `已完成 ${pct}%`);
      appendLog(`${label}${pct == null ? "" : " " + pct + "%"}`);
    } else if (event === "tick") {
      // Heartbeat: this command prints nothing while it works, so the elapsed
      // clock is what proves the run is still alive.
      if (typeof data.elapsedMs === "number") {
        $("#pbTime").textContent = fmtElapsed(data.elapsedMs);
        setStatus(`运行中 ${fmtElapsed(data.elapsedMs)}`, "run");
      }
      if (data.stage) setStageText(data.stage, data.note);
    } else if (event === "result") {
      state.lastResult = data;
      renderOutput();
      // REA reports failures as a normal result envelope (with a code and a
      // remediation hint) rather than a crash. Classify it so the banner says
      // what actually went wrong instead of always blaming a missing engine.
      const notice = describeEnvelopeError(data);
      if (notice) addNotice(notice.title, notice.body);
    } else if (event === "log" || event === "stderr") {
      appendLog(data.line || "");
    } else if (event === "failed") {
      $("#output").textContent = String(data.error || "");
      setStatus("出错", "err");
    } else if (event === "done") {
      this.finish(data.exitCode);
    }
  }
  finish(code) {
    state.running = false;
    stopElapsedTimer();
    $("#runBtn").classList.remove("hidden");
    $("#stopBtn").classList.add("hidden");
    const box = $("#progressBox");
    const fill = $("#pbFill");
    if (code === "stopped") {
      box.classList.add("cancelled");
      fill.className = "pb-fill stopped";
      setStatus("已停止", "");
      setStageText("已取消", "已终止 REA 进程及其 Ghidra 子进程");
      return;
    }
    if (code === 0) {
      box.classList.add("done");
      fill.className = "pb-fill full";
      setStatus("完成", "ok");
    } else {
      box.classList.add("cancelled");
      fill.className = "pb-fill stopped";
      setStatus(`退出码 ${code}`, "err");
    }
  }
  stop() {
    if (state.running) {
      setStageText("正在取消…", "已发送终止信号，正在回收 Ghidra 子进程");
    }
    // Explicit cancel, so the server tears the process tree down even if this
    // page is closed before the aborted request is noticed.
    if (state.runId) {
      fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: state.runId }),
      }).catch(() => {});
    }
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

// Turn a REA failure envelope into a title + explanation for the UI banner.
// Returns null for a successful envelope so the caller can skip the banner.
function describeEnvelopeError(data) {
  if (!data || typeof data !== "object") return null;
  const code = data.code || data.error_code;
  const isError =
    code ||
    data.remediation ||
    (Array.isArray(data.details?.issues) && data.details.issues.length);
  if (!isError) return null;

  const lines = [];
  const msg = data.message || data.reason || "";
  if (msg) lines.push(msg);

  // `issues` carries the precise, actionable part (which argument, why).
  const issues = data.details?.issues;
  if (Array.isArray(issues) && issues.length) {
    lines.push("", "需要修正：");
    for (const it of issues.slice(0, 8)) {
      const where = Array.isArray(it.path) ? it.path.join(".") : it.path || "";
      lines.push(`  · ${where ? where + "：" : ""}${it.message || it.reason || ""}`);
    }
  }
  const rejections = formatRejections(data.details?.rejections);
  if (rejections) lines.push("", rejections);
  if (data.remediation?.action && !issues?.length) lines.push("", "建议：" + data.remediation.action);

  // Commands such as decompile/function/xrefs need a selector; REA reports the
  // missing argument as an invalid_input envelope. Give the specific hint first
  // so it is not swallowed by the generic branch below.
  const needsSelector = Array.isArray(issues) &&
    issues.some((it) => it.reason === "missing_argument");
  if (needsSelector) {
    return {
      title: "缺少定位参数",
      body: lines.join("\n") +
        "\n\n提示：decompile / function / instructions / xrefs 需要一个函数名或地址，请填写「address」参数，或使用「procedure」选项。",
    };
  }

  if (code === "invalid_request" || code === "invalid_input") {
    return { title: "参数有误", body: lines.join("\n") };
  }
  if (code === "provider_unavailable" || code === "engine_unavailable") {
    return { title: "需要外部引擎", body: lines.join("\n") };
  }
  if (code === "unsupported_target" || code === "unsupported_format") {
    return { title: "不支持的目标", body: lines.join("\n") };
  }
  return { title: code ? `执行失败（${code}）` : "执行失败", body: lines.join("\n") || "命令未能完成。" };
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
  // Error envelopes are meant to be read, not parsed: render the message and
  // the offending arguments as plain text instead of a wall of JSON.
  if (r.code && !r.raw_result && !r.normalized_result) {
    $("#output").textContent = formatErrorEnvelopeText(r);
    return;
  }
  if (state.outTab === "result") {
    const text = primaryText(r);
    $("#output").textContent = text != null ? text : JSON.stringify(collapse(r), null, 2);
  } else if (state.outTab === "evidence") {
    $("#output").textContent = extractEvidence(r);
  } else {
    $("#output").textContent = JSON.stringify(r, null, 2);
  }
}

// Commands such as decompile return the interesting artefact (pseudo-code) as a
// multi-line string inside normalized_result. Show that directly instead of
// wrapping it in an escaped JSON envelope the user has to read around.
function primaryText(r) {
  const candidates = [r.normalized_result, r.raw_result && r.raw_result.value];
  for (const v of candidates) {
    if (typeof v === "string" && v.includes("\n") && v.trim().length > 60) return v;
  }
  return null;
}

function formatErrorEnvelopeText(r) {
  const out = [`状态：失败（${r.code || "unknown"}）`];
  if (r.message) out.push("", r.message);
  const issues = r.details?.issues;
  if (Array.isArray(issues) && issues.length) {
    out.push("", "需要修正：");
    for (const it of issues) {
      const where = Array.isArray(it.path) ? it.path.join(".") : it.path || "";
      out.push(`  · ${where ? where + "：" : ""}${it.message || it.reason || ""}`);
    }
  }
  const rej = formatRejections(r.details?.rejections);
  if (rej) out.push("", rej);
  if (r.remediation?.action) out.push("", "建议：" + r.remediation.action);
  return out.join("\n");
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

  // The answer can take minutes (every REA command re-imports the binary into
  // Ghidra), so the bubble reports the live round/command instead of "thinking".
  const pending = addMsg("assistant", "思考中…");
  const started = Date.now();
  let note = "正在请求模型…";
  let round = 0;
  const paint = () => {
    if (!pending.isConnected) return;
    pending.textContent = `${fmtElapsed(Date.now() - started)}  ${note}`;
  };
  paint();
  const ticker = setInterval(paint, 1000);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.chat, ...cfg, stream: true }),
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let finalReply = null;
    let streamError = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = frame.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
        const dl = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dl) continue;
        let d;
        try { d = JSON.parse(dl.slice(6)); } catch { continue; }

        if (ev === "chat_round") {
          round = d.round;
          note = `第 ${d.round}/${d.maxRounds} 轮：模型正在决定下一步…`;
        } else if (ev === "chat_exec") {
          note = `第 ${d.round} 轮：正在执行 ${d.command}`;
        } else if (ev === "chat_exec_done") {
          note = d.error
            ? `第 ${round} 轮：命令失败，模型正在调整…`
            : `第 ${round} 轮：命令完成（${(d.ms / 1000).toFixed(0)}s），模型正在整理…`;
        } else if (ev === "chat_final") {
          finalReply = d.reply || "";
        } else if (ev === "chat_error") {
          streamError = d.error || "未知错误";
        }
        paint();
      }
    }

    clearInterval(ticker);
    pending.remove();
    if (streamError) throw new Error(streamError);
    if (finalReply == null) throw new Error("连接中断，未收到模型回复");
    addMsg("assistant", finalReply);
    state.chat.push({ role: "assistant", content: finalReply });
  } catch (e) {
    clearInterval(ticker);
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
// The progress card carries its own cancel button so the run can be stopped
// without scrolling back up to the toolbar.
$("#pbCancel").addEventListener("click", () => state.es?.stop());
$("#pbToggle").addEventListener("click", () => {
  const log = $("#progress");
  const nowHidden = log.classList.toggle("hidden");
  $("#pbToggle").textContent = nowHidden ? "详情" : "收起";
});
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
