// Build a self-contained HTML copy of the blog post with every screenshot
// inlined as a base64 data URI, so the file renders offline with no sidecar
// images and survives being pasted into editors that rewrite or drop links.
//
// Usage: node tools/build-blog-html.mjs

import { Buffer } from "node:buffer";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const BLOG = join(root, "blog");
const IMG_DIR = join(BLOG, "images");
const POST = join(BLOG, "REA-UI-介绍.md");
const OUT = join(BLOG, "REA-UI-介绍.html");

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// --- inline every screenshot ------------------------------------------------
const inline = new Map();
for (const f of readdirSync(IMG_DIR)) {
  const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
  if (!MIME[ext]) continue;
  const b64 = readFileSync(join(IMG_DIR, f)).toString("base64");
  inline.set(f, `data:${MIME[ext]};base64,${b64}`);
}
console.log(`[blog] inlined ${inline.size} images (${[...inline.values()]
  .reduce((n, d) => n + d.length, 0)
  .toString()} base64 chars)`);

// --- minimal Markdown renderer ----------------------------------------------
// Only the constructs this post actually uses: headings, paragraphs, lists,
// fenced code, tables, links, images, blockquotes, inline code and rules.
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function inlineMd(s) {
  let out = escapeHtml(s);
  // images: ![alt](path) -> data URI when known
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
    const name = decodeURIComponent(src.split("/").pop());
    const data = inline.get(name);
    if (!data) return m;
    // No loading="lazy": the whole point of this build is one portable file,
    // and lazy loading leaves below-the-fold images undecoded when the file is
    // opened straight from disk or pasted into an editor.
    return `<img src="${data}" alt="${alt}">`;
  });
  // links
  out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // bare autolinks (inside <> already escaped, so match the plain form)
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return out;
}

function render(md) {
  // Strip HTML comments: they are notes for source readers ("<!-- 截图：… -->")
  // and must not surface as visible text in the rendered page.
  md = md.replace(/^<!--[\s\S]*?-->\s*$/gm, "");

  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null;
  let inQuote = false;
  let tableBuf = [];

  const flushList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (inQuote) {
      html.push("</blockquote>");
      inQuote = false;
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((r) =>
      r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
    );
    const [head, ...body] = rows;
    html.push("<table><thead><tr>" + head.map((c) => `<th>${inlineMd(c)}</th>`).join("") + "</tr></thead><tbody>");
    for (const r of body) {
      if (r.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      html.push("<tr>" + r.map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>");
    }
    html.push("</tbody></table>");
    tableBuf = [];
  };
  const flushAll = () => {
    flushList();
    flushQuote();
    flushTable();
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        html.push(
          `<pre><code class="lang-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`
        );
        inCode = false;
        codeBuf = [];
      } else {
        flushAll();
        inCode = true;
        codeLang = fence[1] || "";
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // table row
    if (/^\|/.test(line.trim())) {
      flushList();
      flushQuote();
      tableBuf.push(line.trim());
      i++;
      continue;
    } else if (tableBuf.length) {
      flushTable();
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lv = h[1].length;
      html.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*---\s*$/.test(line)) {
      flushAll();
      html.push("<hr>");
      i++;
      continue;
    }

    // blockquote
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushList();
      if (!inQuote) {
        html.push("<blockquote>");
        inQuote = true;
      }
      html.push(`<p>${inlineMd(q[1])}</p>`);
      i++;
      continue;
    } else if (inQuote) {
      flushQuote();
    }

    // lists
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushQuote();
      flushTable();
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        flushList();
        html.push(`<${want}>`);
        listType = want;
      }
      html.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      i++;
      continue;
    } else if (line.trim() === "") {
      flushAll();
      i++;
      continue;
    } else {
      flushList();
    }

    // paragraph
    html.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }
  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  flushAll();
  return html.join("\n");
}

const body = render(readFileSync(POST, "utf8"));

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>给 REA 套一层 GUI：153 个命令的界面是怎么自动长出来的</title>
<style>
:root {
  --bg: #ffffff;
  --bg-soft: #f7f7f8;
  --fg: #1c1c1e;
  --fg-2: #5f5e5a;
  --fg-3: #8a8985;
  --line: rgba(0, 0, 0, 0.11);
  --accent: #534ab7;
  --code-bg: #f5f5f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a;
    --bg-soft: #1e1e22;
    --fg: #ececef;
    --fg-2: #a8a7a4;
    --fg-3: #7c7b78;
    --line: rgba(255, 255, 255, 0.13);
    --accent: #afa9ec;
    --code-bg: #121215;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
main { max-width: 780px; margin: 0 auto; padding: 48px 24px 96px; }
h1 { font-size: 30px; line-height: 1.3; font-weight: 600; margin: 0 0 28px; }
h2 {
  font-size: 21px; font-weight: 600; margin: 44px 0 14px;
  padding-bottom: 8px; border-bottom: 1px solid var(--line);
}
h3 { font-size: 17px; font-weight: 600; margin: 28px 0 10px; }
p { margin: 14px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 600; }
code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.88em; background: var(--code-bg);
  padding: 2px 5px; border-radius: 4px;
}
pre {
  background: var(--code-bg); border: 1px solid var(--line);
  border-radius: 8px; padding: 14px 16px; overflow-x: auto; margin: 18px 0;
}
pre code { background: none; padding: 0; font-size: 13px; line-height: 1.6; }
blockquote {
  margin: 18px 0; padding: 4px 18px;
  border-left: 3px solid var(--accent);
  background: var(--bg-soft); border-radius: 0 8px 8px 0;
}
blockquote p { margin: 8px 0; color: var(--fg-2); }
ul, ol { padding-left: 26px; margin: 14px 0; }
li { margin: 6px 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 36px 0; }
table {
  width: 100%; border-collapse: collapse; margin: 18px 0;
  font-size: 14px; display: block; overflow-x: auto;
}
th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
th { background: var(--bg-soft); font-weight: 600; }
img {
  display: block; max-width: 100%; height: auto;
  margin: 22px auto; border-radius: 8px; border: 1px solid var(--line);
}
@media (max-width: 640px) {
  main { padding: 28px 16px 64px; }
  h1 { font-size: 24px; }
  h2 { font-size: 19px; }
  body { font-size: 15px; }
}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

writeFileSync(OUT, page, "utf8");
console.log(`[blog] wrote ${OUT}`);
