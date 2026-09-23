/**
 * Markdown 渲染管线 — 对齐上游 OpenClaw `ui/src/components/markdown.ts` 的关键能力：
 *   1. markdown-it 解析（GFM + linkify + strikethrough + task lists）
 *   2. highlight.js 做代码高亮（核心 14 种语言 + 自动检测）
 *   3. DOMPurify 清洗 XSS / 危险 URL scheme
 *   4. 流式渲染：找到稳定边界，稳定部分走完整 sanitize，未稳定尾部按纯文本转义追加
 *   5. 文本方向检测（detectTextDirection）— 给容器加 `dir="rtl" | "ltr"`
 *   6. 「伪表格」预处理：Agent 自创的 `||` 双竖线 + `-------` 视觉分隔，
 *      在送进 markdown-it 之前转换成标准 GFM `| ... |` 表格语法。
 *
 * 这层是从上游 chat-message.ts 的 `<div class="chat-text" dir="${detectTextDirection(markdown)}">
 *   ${unsafeHTML(toStreamingMarkdownHtml(markdown, markdownRenderOptions))}
 * </div>` 移植到 Vue 3 的实现。
 */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";

// ── 1. 文本方向检测 ──
// 移植自 ui/src/lib/text-direction.ts：检测 Hebrew / Arabic / Syriac / Thaana /
// Nko / Samaritan / Mandaic / Adlam / Phoenician / Lydian 这些 RTL 脚本。
// 默认跳过 whitespace + Unicode punctuation/symbol，只看第一个有意义的字符。
const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

export function detectTextDirection(
  text: string | null | undefined,
  skipPattern: RegExp = /[\s\p{P}\p{S}]/u,
): "rtl" | "ltr" {
  if (!text) return "ltr";
  for (const char of text) {
    if (skipPattern.test(char)) continue;
    return RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
  }
  return "ltr";
}

// ── 2. 流式渲染稳定边界 ──
// 移植自 ui/src/components/markdown.ts 的 findStableStreamingMarkdownBoundary：
// 从前往后扫行，遇到空行就推进 boundary；遇到代码栅栏（` ``` ` 或 `~~~`）就追踪开闭，
// 直到对应关闭围栏才推进 boundary。返回位置保证「boundary 之前的内容是稳定的，
// boundary 之后是尚未稳定的尾部（应按纯文本追加，避免边解析边重排导致闪烁 / 解析错位）」。
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

type Fence = { marker: "`" | "~"; length: number };

function getFenceMarker(line: string): Fence | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const fence = m[1];
  return { marker: fence[0] as "`" | "~", length: fence.length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const trimmed = line.trimEnd();
  const m = FENCE_OPEN_RE.exec(trimmed);
  if (!m) return false;
  if (m[1][0] !== fence.marker) return false;
  if (m[1].length < fence.length) return false;
  return trimmed.slice(m[0].length).trim() === "";
}

export function findStableStreamingMarkdownBoundary(markdown: string): number {
  let boundary = 0;
  let index = 0;
  let openFence: Fence | null = null;
  while (index < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        boundary = lineEnd;
      }
      index = lineEnd;
      continue;
    }

    const opening = getFenceMarker(line);
    if (opening) {
      openFence = opening;
      index = lineEnd;
      continue;
    }

    if (line.trim() === "") {
      boundary = lineEnd;
    }
    index = lineEnd;
  }
  return boundary;
}

// ── 3. 「伪表格」预处理 ──
// Agent 经常用 `||` 双竖线 + `-------` 视觉分隔来表达表格（不是标准 GFM）。
// 直接送进 markdown-it 会渲染成普通段落。这里先把它们转成标准 GFM 表格语法
// `| col1 | col2 |\n| --- | --- |\n| a | b |`，markdown-it 自然就能识别。
//
// 启发式：
//   - 首行首 cell 含 emoji（`📄`/`📝`/...）或"包含 / 文档 / 目录 / 如下 / 见表"
//     这类说明性 prefix → 当作 caption 独立渲染成段落，表格从第二列开始；
//   - 否则整段当作「首行作 header、其余作 row」的普通表格；
//   - 视觉分隔 cell（`---` / `===` / `***` 等只有 `-`/`=`/`*` 重复 ≥ 2）直接过滤；
//   - pad 到 maxCols，空 cell 用 ` ` 占位（markdown-it 表格对空 cell 容忍）。
function looksLikePseudoTableRow(line: string): boolean {
  return line.includes("||");
}

/**
 * 「纯视觉分隔行」：只由 `|` / 空白 / `-`=`*` 重复段组成，例如 `|| --- || --- ||`。
 *
 * 这类行在伪表格里是**表头与数据之间的分隔线**，必须被识别为"跳过"而不是"表格结束"，
 * 否则表格会从第一行数据重新开始（表头被吞成段落、首行数据被当成表头）。
 */
function isPseudoSeparatorRow(line: string): boolean {
  if (!line.includes("||")) return false;
  const stripped = line.replace(/[|\s]/g, "");
  return stripped.length > 0 && /^[-=*]+$/.test(stripped);
}

function splitPseudoTableRow(line: string): string[] {
  const parts = line.split(/\s*\|\|\s*/);
  const cells: string[] = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (/^[-=*]{2,}$/.test(trimmed)) continue; // 视觉分隔 cell
    if (trimmed.includes("|")) {
      // cell 内还有单 `|`（截图 Case 5：`|| 8小时时间表 | 模板速记→...`）
      for (const c2 of trimmed.split(/\s*\|\s*/)) {
        const t = c2.trim();
        if (t) cells.push(t);
      }
    } else {
      // 空 cell 不扔掉 — 否则 `|| 翻译必背15组` 这种 2 列格式会被判成 1 列
      cells.push(trimmed);
    }
  }
  // 去掉尾部空 cell（视觉分隔残留：`||-------||` 末尾的 `||` 切出 ""）
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function convertPseudoTableToGfm(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!looksLikePseudoTableRow(line)) {
      out.push(line);
      i++;
      continue;
    }

    // 独立的视觉分隔行（不属于任何表格）→ 直接丢弃，不再渲染成 `|| --- ||` 这种乱码。
    // 放在最前面，保证 i 一定前进。
    if (isPseudoSeparatorRow(line)) {
      i++;
      continue;
    }

    // ⚠️ 必须先单独校验当前行能否切出 ≥2 个 cell，再进入"收集连续行"循环。
    // 否则遇到只能切出 0/1 个 cell 的行会 break → rows 为空 → i 不前进 → while 死循环，整页卡死。
    const headCells = splitPseudoTableRow(line);
    if (headCells.length < 2) {
      out.push(line);
      i++;
      continue;
    }

    // 收集连续 `||` 数据行（能切出 ≥2 cell 的才算）。
    // 表格内部的分隔行（`|| --- || --- ||`）要**跳过**而不是终止收集。
    const start = i;
    const rows: string[][] = [];
    while (i < lines.length && lines[i].includes("||")) {
      if (isPseudoSeparatorRow(lines[i])) {
        i++;
        continue;
      }
      const cells = splitPseudoTableRow(lines[i]);
      if (cells.length < 2) break;
      rows.push(cells);
      i++;
    }
    if (rows.length < 2) {
      // 只有一行 → 不足以构成表格，原样回填这几行。
      // `i` 此时已前进（至少消费了 1 行），不会死循环。
      out.push(...lines.slice(start, i));
      continue;
    }

    // pad 到相同列数
    const maxCols = Math.max(...rows.map((r) => r.length));
    const padded = rows.map((r) => {
      const out = r.slice(0, maxCols);
      while (out.length < maxCols) out.push("");
      return out;
    });

    // 去掉「首列恒为空」的伪列：`|| a || b ||` 按 `||` 切分时行首会产生一个空 cell，
    // 那是定界符的副产物，不是真实数据列（否则表格左边会多出一整列空白）。
    while (padded[0].length > 1 && padded.every((r) => r[0] === "")) {
      for (const r of padded) r.shift();
    }

    const firstCell = padded[0][0] || "";
    const looksLikeCaption =
      /[\u{1F300}-\u{1FAFF}]|包含|文档|目录|如下|见表/u.test(firstCell) &&
      padded[0].length > 2 &&
      padded.length > 1;

    if (looksLikeCaption) {
      out.push(firstCell, "");
      const header = padded[0].slice(1);
      const rowsAligned = padded.slice(1).map((r) => {
        const trimmed = r[0] === "" ? r.slice(1) : r.slice();
        while (trimmed.length < header.length) trimmed.push("");
        return trimmed.slice(0, header.length);
      });
      out.push(...rowsToGfmTable(header, rowsAligned));
    } else {
      out.push(...rowsToGfmTable(padded[0], padded.slice(1)));
    }
    out.push("");
  }
  return out.join("\n");
}

function rowsToGfmTable(header: string[], rows: string[][]): string[] {
  const sep = header.map(() => "---");
  const fmt = (cells: string[]) => `| ${cells.map((c) => c || " ").join(" | ")} |`;
  return [fmt(header), fmt(sep), ...rows.map(fmt)];
}

// ── 4. markdown-it 实例 + hljs + DOMPurify 配置 ──

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = [
  "checked",
  "class",
  "disabled",
  "href",
  "rel",
  "target",
  "title",
  "start",
  "src",
  "alt",
  "type",
  "aria-label",
];

const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};

// 注册语言（与上游 markdown.ts 同样的核心 14 种）
for (const [language, definition, aliases] of [
  ["bash", bash, ["sh", "shell"]],
  ["cpp", cpp, ["c++", "cxx"]],
  ["css", css, []],
  ["diff", diff, ["patch"]],
  ["go", go, ["golang"]],
  ["java", java, []],
  ["javascript", javascript, ["js", "jsx"]],
  ["json", json, []],
  ["markdown", markdown, ["md"]],
  ["python", python, ["py"]],
  ["rust", rust, ["rs"]],
  ["typescript", typescript, ["ts", "tsx"]],
  ["xml", xml, ["html", "svg"]],
  ["yaml", yaml, ["yml"]],
] as const) {
  hljs.registerLanguage(language, definition);
  if (aliases.length > 0) {
    hljs.registerAliases([...aliases], { languageName: language });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeHighlightLanguage(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return "";
  const aliases: Record<string, string> = {
    "c++": "cpp",
    cxx: "cpp",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
  };
  return aliases[normalized] ?? normalized;
}

const autoHighlightLanguages = [
  "bash",
  "cpp",
  "css",
  "diff",
  "go",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "typescript",
  "xml",
  "yaml",
];

function highlightCode(text: string, lang: string): string {
  const language = normalizeHighlightLanguage(lang);
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    if (!language && text.trim()) {
      const result = hljs.highlightAuto(text, autoHighlightLanguages);
      if (result.relevance >= 2) {
        return result.value;
      }
    }
  } catch {
    // 异常时回落转义后的纯文本
  }
  return escapeHtml(text);
}

function renderCodeBlockHtml(text: string, lang: string): string {
  const highlighted = highlightCode(text, lang);
  const classes = [
    highlighted.includes("hljs-") ? "hljs" : "",
    lang ? `language-${lang}` : "",
  ].filter(Boolean);
  const classAttr = classes.length > 0 ? ` class="${escapeHtml(classes.join(" "))}"` : "";
  return `<pre><code${classAttr}>${highlighted}</code></pre>`;
}

// 单一共享实例 — markdown-it 配置与上游 markdown.ts 对齐
//  - html: true 开启 HTML 识别（再由下面的 renderer rules 把 html_block / html_inline 转义）
//  - breaks: true 把单个换行渲染成 <br>（与 marked.js 行为一致）
//    ⚠️ 段落内的「孤立换行」在进 markdown-it 之前已被 `mergeSoftLineBreaks()` 合并掉，
//    所以 breaks 现在只对**结构边界**（列表 / 代码围栏 / 表行 / 标题 / MEDIA 行…）真正生效 ——
//    中文正文里模型偶发的一句一换行不会再上屏成 <br>（2026-09-23 用户口径，详见该函数注释）。
//  - linkify: true 自动识别 URL
const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});
md.enable("strikethrough");

// 关闭 fuzzy link，避免 README.md 这种文件名被自动链成 http://README.md
md.linkify.set({ fuzzyLink: false });

// 所有 URL 都过 validator，靠 DOMPurify 兜底（与 marked.js 行为一致）
md.validateLink = () => true;

// 把非受信任的 HTML 转义掉
md.renderer.rules.html_block = (tokens, idx) => `${escapeHtml(tokens[idx].content)}\n`;
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx].content);

// fenced code block 用 hljs 高亮
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] || "";
  return renderCodeBlockHtml(token.content, lang);
};

md.renderer.rules.code_block = (tokens, idx) => {
  return renderCodeBlockHtml(tokens[idx].content, "");
};

// 图片只允许 data: URI（base64 内嵌），其他用 alt 文本兜底
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet("src")?.trim() ?? "";
  const alt = token.content?.trim() || "image";
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) {
    return escapeHtml(alt);
  }
  return `<img class="markdown-inline-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
};

// GFM task list 复选框：display-only（disabled），不开 label 包裹（label 内嵌链接会破 a11y）
md.use(markdownItTaskLists, { enabled: false, label: false });

/** 围栏开始/结束行（``` / ~~~）—— 代码块内的换行是内容，绝不合并。 */
const SOFT_BREAK_FENCE_RE = /^(?:`{3,}|~{3,})/;

/**
 * 结构行：标题 / 引用 / 列表项 / 表行 / 分隔线。
 * ⚠️ 列表与分隔线的标记必须**后接空白或行尾**，否则 `**加粗**`、`*斜体*`、`----` 这类
 * 行首会被误判成列表标记。
 */
const SOFT_BREAK_STRUCT_RE =
  /^(?:#{1,6}(?:\s|$)|>(?:\s|$)|[-*+](?:\s|$)|\d+[.)](?:\s|$)|\||(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/** 行首 4 空格 / Tab = 缩进代码块或列表续行，保持原样（⚠️ 判的是**原始行**，不是去掉左空白后的）。 */
const SOFT_BREAK_INDENT_RE = /^(?:\t| {4,})/;

/**
 * 行内含 `MEDIA:` 投递标记。
 * ⚠️ 连续两条 `MEDIA:` 行若被合到同一行，会产出「同一行多条 MEDIA:」的病态输入
 * （`mediaMarker.ts` 为它专门加固过：可能出现假 URL 或整行原文泄漏）⇒ 别把好输入喂成病态输入。
 */
const SOFT_BREAK_MEDIA_RE = /\bMEDIA:/i;

/** 全角/汉字（含中文标点、全角符号），用于决定合并时**补不补空格**。 */
const FULL_WIDTH_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/**
 * @param raw 原始行（带左空白）
 * @param trimmed 去掉左空白后的行（块级标记按 CommonMark 允许最多 3 个前导空格）
 */
function isStructuralSoftBreakLine(raw: string, trimmed: string): boolean {
  return (
    SOFT_BREAK_FENCE_RE.test(trimmed) ||
    SOFT_BREAK_STRUCT_RE.test(trimmed) ||
    SOFT_BREAK_INDENT_RE.test(raw)
  );
}

/**
 * 把「段落内的**孤立换行**」合并掉 —— 合并后 markdown-it 不再把它渲染成 `<br>`。
 *
 * ## 为什么需要（2026-09-23，用户截图）
 * 气泡里出现 `没问题 ⏎ ，小主～…`：换行位置**来自 agent 正文自己的 `\n`**
 * （实测全库 1008 条助手正文命中 2 例：`你好\n！…`、`没问题\n，…`），
 * web 侧本来只是把它显示成换行（`breaks: true`，与上游 `ui/src/components/markdown.ts` 同款）。
 * 用户口径 = **最大化合并**：中文正文里所有「不以空行分隔」的单换行都不再产生 `<br>`。
 *
 * ## 合并成什么
 * 换行两侧都是全角字符 ⇒ **不补空格**（`没问题\n，` → `没问题，`）；
 * 其余（英文单词被换行切开）⇒ **补一个空格**（`hello\nworld` → `hello world`），
 * 与 CommonMark 的软换行语义一致。
 *
 * ## 五类**不合并**（结构 / 语义保护，都不是「正文里的换行」）
 * 1. 空行边界（`\n{2,}`）—— 段落分隔，合了就丢段落；
 * 2. 围栏代码块内部（``` / ~~~）—— 代码里的换行是内容；
 * 3. 本行或下一行是结构行（标题 / 引用 / 列表 / 表行 / 分隔线 / 行首 4 空格或 Tab）
 *    —— 合了会吃掉一个 bullet、标题或表行；
 * 4. 显式硬换行（行尾两个空格或反斜杠）—— 那是明确要的换行；
 * 5. 涉及 `MEDIA:` 的行（见 `SOFT_BREAK_MEDIA_RE`）。
 *
 * ⚠️ **调用点只有两处**（`toSanitizedMarkdownHtml` / `toStreamingMarkdownHtml`），
 * 且必须在 `convertPseudoTableToGfm()` **之后** —— 伪表格靠「连续单换行」的行结构识别，
 * 先合并就再也不是表格了。
 * ⚠️ 只作用在**展示层**：不写回消息、不喂给 `splitMediaMarkers()`（媒体按原文解析）。
 */
export function mergeSoftLineBreaks(text: string): string {
  if (!text.includes("\n")) return text;

  const lines = text.split("\n");
  let inFence = false;
  let out = "";

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const isFenceLine = SOFT_BREAK_FENCE_RE.test(raw.trim());
    if (isFenceLine) inFence = !inFence;

    if (index === lines.length - 1) {
      out += raw;
      break;
    }

    const current = raw.replace(/[ \t]+$/, "");
    const nextRaw = lines[index + 1];
    const next = nextRaw.replace(/^[ \t]+/, "");
    const keepBreak =
      isFenceLine ||
      inFence ||
      current === "" ||
      next === "" ||
      isStructuralSoftBreakLine(current, current) ||
      isStructuralSoftBreakLine(nextRaw, next) ||
      /[ \t]{2,}$/.test(raw) ||
      /\\$/.test(current) ||
      SOFT_BREAK_MEDIA_RE.test(current) ||
      SOFT_BREAK_MEDIA_RE.test(next);

    if (keepBreak) {
      out += `${raw}\n`;
      continue;
    }

    const prevChar = current.slice(-1);
    const nextChar = next.slice(0, 1);
    const joiner =
      prevChar && nextChar && FULL_WIDTH_RE.test(prevChar) && FULL_WIDTH_RE.test(nextChar)
        ? ""
        : " ";
    out += `${current}${joiner}`;
    // 下一行已并入本行，丢掉它的左空白（否则合并后凭空多出缩进）
    lines[index + 1] = next;
  }

  return out;
}

export type MarkdownRenderOptions = {
  codeBlockChrome?: "copy" | "none";
  fileLinks?: boolean;
};

const MARKDOWN_CHAR_LIMIT = 140_000;

function truncateInput(text: string): string {
  if (text.length <= MARKDOWN_CHAR_LIMIT) return text;
  return `${text.slice(0, MARKDOWN_CHAR_LIMIT)}\n\n… truncated (${text.length} chars).`;
}

function plainTextFallbackHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(value.replace(/\r\n?/g, "\n"))}</div>`;
}

/**
 * 把 markdown 文本完整渲染为 sanitized HTML（无流式分段）。
 * 对齐上游 `toSanitizedMarkdownHtml`：先做伪表格预处理，再走 markdown-it，
 * 最后 DOMPurify 清洗。
 */
export function toSanitizedMarkdownHtml(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string {
  const raw = (markdown || "").replace(/\r\n?/g, "\n");
  const input = raw.trim();
  if (!input) return "";

  const normalized = convertPseudoTableToGfm(input);
  // ⚠️ 顺序不能换：合并必须在伪表格转换**之后**（`mergeSoftLineBreaks` 的注释里写了原因）
  const truncated = truncateInput(mergeSoftLineBreaks(normalized));

  let rendered: string;
  try {
    rendered = md.render(truncated, options);
  } catch (err) {
    // 兜底：渲染失败时按转义后的纯文本输出
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    const escaped = escapeHtml(truncated);
    rendered = `<pre class="code-block">${escaped}</pre>`;
  }
  return DOMPurify.sanitize(rendered, sanitizeOptions);
}

/**
 * 流式渲染：先找稳定边界（最后一个空行 / 闭合围栏之后），
 * 稳定部分走完整 sanitize，尾部按纯文本转义追加。
 * 对齐上游 `toStreamingMarkdownHtml`。
 *
 * ⚠️ 入口先过一遍 `mergeSoftLineBreaks()`：稳定段与纯文本尾部**共用同一份合并结果**，
 * 否则同一行会在稳定段（已合并）与尾部（未合并）之间来回跳。
 */
export function toStreamingMarkdownHtml(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string {
  const raw = (markdown || "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return "";

  const input = mergeSoftLineBreaks(raw.trim());
  const boundary = findStableStreamingMarkdownBoundary(input);
  if (boundary <= 0) {
    // 还没遇到稳定边界（连第一段都没结束），整段按纯文本展示，避免半截渲染闪烁
    return plainTextFallbackHtml(input);
  }

  const stableMarkdown = input.slice(0, boundary);
  const streamingTail = input.slice(boundary);
  const stableHtml = toSanitizedMarkdownHtml(stableMarkdown, options);
  if (!streamingTail.trim()) return stableHtml;
  return `${stableHtml}${plainTextFallbackHtml(streamingTail)}`;
}

/**
 * 兼容旧版 MD 组件中可能用到的「仅纯文本兜底」。
 */
export function toEscapedPlainTextHtml(markdown: string): string {
  return plainTextFallbackHtml(markdown);
}