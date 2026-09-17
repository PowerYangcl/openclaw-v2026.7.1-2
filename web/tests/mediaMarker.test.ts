/**
 * 单元测试：正文里的 `MEDIA:<引用>` 文本约定解析（`src/utils/mediaMarker.ts`）。
 *
 * ## 为什么必须锁住
 * 这一个文件是**「助手给的文件没有可点/可下载按钮」的唯一开关**。实测（CDP 读真实
 * `chat.history`）那条 assistant 消息的字段是
 * `role,content,api,provider,model,usage,stopReason,timestamp,responseId,__openclaw`
 * —— **没有 `MediaPaths`**，唯一来源就是正文那一行 `MEDIA:/.../cet4_vocab_batch3.pdf`。
 * 一旦这里少判一种形态（含空格的路径、反引号包裹、`/media/` 同源路径…），
 * 界面就退化成「一行赤裸的 `MEDIA:/...`，没有任何按钮」，而且**不报任何错**。
 *
 * 用例逐条对齐上游 `src/media/parse.ts` 的 `splitMediaFromOutput`(483) /
 * `isValidMedia`(162) / `isAllowedRemoteMediaUrl`(148)，
 * 以及 `ui/src/lib/chat/message-normalizer.ts` 的
 * `isRenderableAssistantAttachment`(102) / `shouldPreserveRelativeAssistantAttachment`(115) /
 * `inferAttachmentKind`(181)。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:media-marker`）
 */
import {
  inferMediaAttachment,
  isRenderableMediaReference,
  mimeTypeForMediaPath,
  normalizeMediaSource,
  splitMediaMarkers,
} from "@/utils/mediaMarker";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    fail++;
    console.log("  \u2717", name, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n[1] 真实 case：助手正文里的 PDF（本次 bug 的现场）");
{
  const source =
    "PDF 已重新生成，无警告了 \u2705\n\nMEDIA:/Users/wangyongbo26/.openclaw/workspace/cet4_vocab_batch3.pdf";
  const split = splitMediaMarkers(source);
  ok("可渲染引用被剥离出来", split.media.length === 1, split);
  ok(
    "引用是完整的本地绝对路径",
    split.media[0] === "/Users/wangyongbo26/.openclaw/workspace/cet4_vocab_batch3.pdf",
    split.media,
  );
  ok(
    "正文里那行 `MEDIA:` 消失了（不再赤裸显示）",
    split.text === "PDF 已重新生成，无警告了 \u2705",
    JSON.stringify(split.text),
  );
  const att = inferMediaAttachment(split.media[0]!);
  ok("推断为 document（PDF）", att.kind === "document", att);
  ok("label 是文件名", att.label === "cet4_vocab_batch3.pdf", att);
  ok("mimeType = application/pdf", att.mimeType === "application/pdf", att);
}

console.log("\n[2] 与正文混排：只吃 MEDIA 行，其余文本原样保留");
{
  const split = splitMediaMarkers("Hello\nMEDIA:/tmp/openclaw/test-image.png\nWorld");
  ok("两侧文本保留且被拼接", split.text === "Hello\nWorld", JSON.stringify(split.text));
  ok("引用被抽出", split.media[0] === "/tmp/openclaw/test-image.png", split.media);

  const one = splitMediaMarkers("Here\nMEDIA:/tmp/x.png");
  ok(
    "末尾 MEDIA 行：只留前面那段",
    one.text === "Here" && one.media.length === 1,
    JSON.stringify(one),
  );
  ok(
    "整行只有 MEDIA 时正文为空",
    splitMediaMarkers("MEDIA:/tmp/x.png").text === "",
    JSON.stringify(splitMediaMarkers("MEDIA:/tmp/x.png")),
  );
  ok(
    "没有 media 的文本原样返回（快路径）",
    splitMediaMarkers("no media here").text === "no media here",
  );
  ok(
    "多个 MEDIA 行都抽出来",
    (() => {
      const s = splitMediaMarkers("A\nMEDIA:/tmp/a.png\nB\nMEDIA:/tmp/b.pdf");
      return s.media.length === 2 && s.text === "A\nB";
    })(),
  );
  ok("重复引用去重", splitMediaMarkers("MEDIA:/tmp/a.png\nMEDIA:/tmp/a.png").media.length === 1);
}

console.log("\n[3] ⚠️ 围栏（```）内的 MEDIA: 是文档示例，绝不提取");
{
  const fenced = "Example:\n```\nMEDIA:/tmp/x.png\n```\nEnd";
  const split = splitMediaMarkers(fenced);
  ok("围栏内不产出 media", split.media.length === 0, split.media);
  ok("围栏内原文不动", split.text.includes("MEDIA:/tmp/x.png"), JSON.stringify(split.text));
  ok("~~~ 围栏同样保护", splitMediaMarkers("~~~\nMEDIA:/tmp/x.png\n~~~").media.length === 0);
  ok(
    "未闭合围栏：其后内容全部视为栏内",
    splitMediaMarkers("```\nMEDIA:/tmp/x.png").media.length === 0,
  );
  ok(
    "围栏外的 MEDIA 照常被抽（保护不能误伤）",
    (() => {
      const s = splitMediaMarkers("MEDIA:/tmp/outside.png\n```\nMEDIA:/tmp/inside.png\n```");
      return s.media.length === 1 && s.media[0] === "/tmp/outside.png";
    })(),
  );
}

console.log("\n[4] 形态兼容：反引号/引号包裹、含空格路径、Windows、file://、~");
{
  ok(
    "反引号包裹（含空格）",
    (() => {
      const s = splitMediaMarkers("MEDIA:`/tmp/openclaw/my file.png`");
      return s.media[0] === "/tmp/openclaw/my file.png" && s.text === "";
    })(),
  );
  ok("双引号包裹", splitMediaMarkers('MEDIA:"/tmp/my file.png"').media[0] === "/tmp/my file.png");
  ok(
    "⚠️ 未包裹但含空格的本地路径（上游 test image.png 同款）",
    splitMediaMarkers("MEDIA:/tmp/openclaw/test image.png").media[0] ===
      "/tmp/openclaw/test image.png",
    splitMediaMarkers("MEDIA:/tmp/openclaw/test image.png").media,
  );
  ok(
    "Windows 盘符路径",
    splitMediaMarkers("MEDIA:C:\\Users\\Test\\Pictures\\test image.png").media[0] ===
      "C:\\Users\\Test\\Pictures\\test image.png",
    splitMediaMarkers("MEDIA:C:\\Users\\Test\\Pictures\\test image.png").media,
  );
  ok(
    "file:// 前缀被归一成路径",
    splitMediaMarkers("MEDIA:file:///tmp/x.png").media[0] === "/tmp/x.png",
  );
  ok(
    "~/ 家目录相对路径",
    splitMediaMarkers("MEDIA:~/Pictures/My File.png").media[0] === "~/Pictures/My File.png",
    splitMediaMarkers("MEDIA:~/Pictures/My File.png").media,
  );
  ok(
    "大小写不敏感（media: / MEDIA:）",
    splitMediaMarkers("media:/tmp/x.png").media[0] === "/tmp/x.png",
  );
  ok("行首缩进也能识别", splitMediaMarkers("  MEDIA:/tmp/x.png").media.length === 1);
}

console.log("\n[5] ⚠️ 相对引用保留为文本，绝不静默吞掉");
{
  // ⚠️ 行为变更（2026-09-16）：相对 / 裸文件名**产物**现在渲染成卡片，不再保留原文。
  // 原因：网关 `/__openclaw__/assistant-media?source=` 按 agent workspace 解析，相对
  // 引用实际取得到字节；而保留原文的代价是「正文多一行 `MEDIA:./x.html` 脏文本 +
  // 没有下载卡片」，且 chat.history 里网关常已规范成绝对路径 ⇒ 首次返回没卡片、
  // 刷新才有。未知扩展名的相对引用仍按上游保留原文（见 [8] / [11]）。
  ok(
    "裸文件名产物渲染成卡片（chart.png）",
    (() => {
      const s = splitMediaMarkers("MEDIA:chart.png");
      return s.media.length === 1 && s.text === "";
    })(),
    splitMediaMarkers("MEDIA:chart.png"),
  );
  ok(
    "相对子目录产物同样渲染成卡片（sub/x.png）",
    splitMediaMarkers("MEDIA:sub/x.png").media.length === 1,
  );
  ok(
    "⚠️ 目录穿越既不能渲染也**不能**当文本泄漏",
    (() => {
      const s = splitMediaMarkers("MEDIA:../../.env");
      return s.media.length === 0 && s.text === "";
    })(),
    splitMediaMarkers("MEDIA:../../.env"),
  );
  ok(
    "~foo 这种不支持的 home 形式同样丢弃",
    splitMediaMarkers("MEDIA:~foo/x.png").text === "" &&
      splitMediaMarkers("MEDIA:~foo/x.png").media.length === 0,
  );
}

console.log("\n[6] ⚠️ 远程 URL：只放行公开 https（上游 isAllowedRemoteMediaUrl 同口径）");
{
  ok(
    "公开 https 放行",
    splitMediaMarkers("MEDIA:https://example.com/a.png").media[0] === "https://example.com/a.png",
  );
  ok(
    "⚠️ 明文 http 一律拒绝，且保留原文",
    (() => {
      const s = splitMediaMarkers("MEDIA:http://example.com/a.png");
      return s.media.length === 0 && s.text === "MEDIA:http://example.com/a.png";
    })(),
  );
  ok("⚠️ 环回 IP 拒绝", splitMediaMarkers("MEDIA:https://127.0.0.1/a.png").media.length === 0);
  ok("⚠️ 私网 10/8 拒绝", splitMediaMarkers("MEDIA:https://10.1.2.3/a.png").media.length === 0);
  ok(
    "⚠️ 私网 192.168/16 拒绝",
    splitMediaMarkers("MEDIA:https://192.168.1.1/x.png").media.length === 0,
  );
  ok(
    "⚠️ CGNAT 100.64/10 拒绝",
    splitMediaMarkers("MEDIA:https://100.64.0.1/x.png").media.length === 0,
  );
  ok(
    "⚠️ link-local 169.254 拒绝",
    splitMediaMarkers("MEDIA:https://169.254.169.254/x.png").media.length === 0,
  );
  ok("⚠️ 组播 224/4 拒绝", splitMediaMarkers("MEDIA:https://224.0.0.1/x.png").media.length === 0);
  ok(
    "⚠️ 非规范数字形式（2130706433）拒绝",
    splitMediaMarkers("MEDIA:https://2130706433/x.png").media.length === 0,
  );
  ok(
    "⚠️ 十六进制形式（0x7f.0.0.1）拒绝",
    splitMediaMarkers("MEDIA:https://0x7f.0.0.1/x.png").media.length === 0,
  );
  ok(
    "⚠️ .local / .internal 域名拒绝",
    (() => {
      return (
        splitMediaMarkers("MEDIA:https://host.local/x.png").media.length === 0 &&
        splitMediaMarkers("MEDIA:https://metadata.google.internal/x.png").media.length === 0 &&
        splitMediaMarkers("MEDIA:https://x.internal/a.png").media.length === 0
      );
    })(),
  );
  ok(
    "⚠️ 带用户名密码的 URL 拒绝",
    splitMediaMarkers("MEDIA:https://user:pw@example.com/a.png").media.length === 0,
  );
  ok("⚠️ IPv6 环回 [::1] 拒绝", splitMediaMarkers("MEDIA:https://[::1]/a.png").media.length === 0);
  ok(
    "⚠️ IPv6 ULA fc00:: 拒绝",
    splitMediaMarkers("MEDIA:https://[fc00::1]/a.png").media.length === 0,
  );
  ok(
    "⚠️ IPv6 v4-mapped 私网（::ffff:10.0.0.1）拒绝",
    splitMediaMarkers("MEDIA:https://[::ffff:10.0.0.1]/a.png").media.length === 0,
  );
}

console.log("\n[7] 网关已托管的站内路径");
{
  ok(
    "/media/inbound/… 可渲染（上游 chat-message.test.ts:2559 同款）",
    splitMediaMarkers("MEDIA:/media/inbound/test-image.png").media[0] ===
      "/media/inbound/test-image.png",
  );
  ok(
    "/__openclaw__/media/… 可渲染",
    splitMediaMarkers("MEDIA:/__openclaw__/media/test-doc.pdf").media[0] ===
      "/__openclaw__/media/test-doc.pdf",
  );
  // ⚠️ 反直觉但**与上游一致**：`isRenderableMediaReference` 放行 `data:image|audio|video`，
  // 但 `isValidMedia` 只认 http(s) 与本地路径 ⇒ `MEDIA:data:…` 在正文里**不会被提取**。
  // 这个分支是给 `content` 块的 url 用的，不是给文本约定用的。别「顺手修」成能抽——
  // 那会把一整串 base64 塞进附件 URL。
  ok(
    "⚠️ MEDIA:data:image 不被提取，且原样保留为文本（上游同口径）",
    (() => {
      const s = splitMediaMarkers("MEDIA:data:image/png;base64,AAA");
      return s.media.length === 0 && s.text === "MEDIA:data:image/png;base64,AAA";
    })(),
    splitMediaMarkers("MEDIA:data:image/png;base64,AAA"),
  );
  ok(
    "⚠️ data:text/html 同样不可渲染（可执行脚本）",
    splitMediaMarkers("MEDIA:data:text/html,<script>alert(1)</script>").media.length === 0,
  );
}

console.log("\n[8] isRenderableMediaReference / normalizeMediaSource");
{
  ok("绝对路径", isRenderableMediaReference("/tmp/x.png") === true);
  ok("https", isRenderableMediaReference("https://x.com/a.png") === true);
  ok("file://", isRenderableMediaReference("file:///tmp/x.png") === true);
  ok("~/", isRenderableMediaReference("~/x.png") === true);
  ok("Windows 盘符", isRenderableMediaReference("C:\\x.png") === true);
  ok("/media/", isRenderableMediaReference("/media/inbound/a.png") === true);
  ok("/__openclaw__/", isRenderableMediaReference("/__openclaw__/media/a.pdf") === true);
  ok("产物扩展名的裸文件名可渲染", isRenderableMediaReference("chart.png") === true);
  ok("产物扩展名的相对子目录可渲染", isRenderableMediaReference("sub/x.png") === true);
  ok("未知扩展名的相对引用仍保留为文本", isRenderableMediaReference("notes.unknownext") === false);
  ok(
    "normalizeMediaSource 去掉 file://",
    normalizeMediaSource("file:///tmp/x.png") === "/tmp/x.png",
  );
  ok("normalizeMediaSource 对普通路径不动", normalizeMediaSource("/tmp/x.png") === "/tmp/x.png");
}

console.log("\n[9] mimeTypeForMediaPath / inferMediaAttachment 分类");
{
  ok("png → image/png", mimeTypeForMediaPath("/a/b.png") === "image/png");
  ok("pdf → application/pdf", mimeTypeForMediaPath("/a/b.pdf") === "application/pdf");
  ok("mp3 → audio/mpeg", mimeTypeForMediaPath("/a/b.mp3") === "audio/mpeg");
  ok("mp4 → video/mp4", mimeTypeForMediaPath("/a/b.mp4") === "video/mp4");
  ok(
    "query/hash 不干扰取扩展名",
    mimeTypeForMediaPath("https://x.com/a/b.pdf?token=1#p2") === "application/pdf",
  );
  ok("未知扩展名 → undefined", mimeTypeForMediaPath("/a/b.unknownext") === undefined);
  ok("图片 → image", inferMediaAttachment("/a/b.png").kind === "image");
  ok("音频 → audio", inferMediaAttachment("/a/b.mp3").kind === "audio");
  ok("视频 → video", inferMediaAttachment("/a/b.mp4").kind === "video");
  ok("文档 → document", inferMediaAttachment("/a/b.pdf").kind === "document");
  ok(
    "URL 的 label 取 pathname 末段",
    inferMediaAttachment("https://x.com/a/b.pdf?token=1").label === "b.pdf",
  );
  ok(
    "无扩展名 → document 且 label 用末段",
    (() => {
      const att = inferMediaAttachment("/a/README");
      return att.kind === "document" && att.label === "README";
    })(),
  );
}

console.log("\n[10] 边界与健壮性");
{
  ok(
    "空串 → 空结果",
    splitMediaMarkers("").text === "" && splitMediaMarkers("").media.length === 0,
  );
  ok("空白串 → 空结果", splitMediaMarkers("   \n  ").text === "");
  ok(
    "非字符串输入 → 空结果",
    splitMediaMarkers(null).text === "" &&
      splitMediaMarkers(undefined).media.length === 0 &&
      splitMediaMarkers(42).text === "",
  );
  ok(
    "只有 `media:` 但不是 MEDIA 标记 → 不解析",
    (() => {
      const s = splitMediaMarkers("discussing media: policy");
      return s.media.length === 0 && s.text === "discussing media: policy";
    })(),
  );
  ok(
    "超长引用（>4096）被拒",
    (() => {
      const long = "/tmp/" + "a".repeat(4200) + ".png";
      return splitMediaMarkers("MEDIA:" + long).media.length === 0;
    })(),
  );
  ok("MEDIA: 后面没内容 → 不产出", splitMediaMarkers("MEDIA:").media.length === 0);
  ok(
    "多个连续空行被压平（与上游同款收尾清理）",
    splitMediaMarkers("A\n\n\nMEDIA:/tmp/x.png\n\n\nB").text === "A\nB",
  );
}

console.log("\n[11] HTML 产物：相对路径也要能变成附件（首次返回就要有下载入口）");
{
  const raw = "游戏做好了 \ud83d\udc47\nMEDIA:./lobster-invaders.html";
  const split = splitMediaMarkers(raw);
  ok(
    "相对路径的 .html ⇒ 产出一条引用",
    split.media.length === 1 && split.media[0] === "./lobster-invaders.html",
    split.media,
  );
  ok(
    "正文里那行 `MEDIA:` 被剥掉（不再赤裸裸显示）",
    !split.text.includes("MEDIA:") && split.text === "游戏做好了 \ud83d\udc47",
    JSON.stringify(split.text),
  );
  ok("裸文件名 report.html 也算产物", splitMediaMarkers("MEDIA:report.html").media.length === 1);
  ok("相对路径判为可渲染", isRenderableMediaReference("./lobster-invaders.html"));
  ok("未知扩展名的相对引用仍按上游保留原文", !isRenderableMediaReference("notes.unknownext"));
  ok(
    ".html 现在有 MIME 了（此前表里缺 html，卡片拿不到类型）",
    mimeTypeForMediaPath("/w/report.html") === "text/html",
    mimeTypeForMediaPath("/w/report.html"),
  );
  ok(
    "HTML 产物归类为 document ⇒ 出下载卡片",
    inferMediaAttachment("/w/report.html").kind === "document",
    inferMediaAttachment("/w/report.html"),
  );
}
console.log("\n[12] mp3 / pdf / html 三条链路同口径：流式正文提取 = final 落库 = 历史加载");
{
  // 同一段正文，流式（splitMediaMarkers 直接跑）与 final/历史（normalizeMessage 内部
  // 也跑同一个函数）必须得到同一组 media —— 这是「不用刷新就能点下载」的根。
  const cases: Array<[string, string, string]> = [
    ["mp3 绝对路径", "音频已生成 \nMEDIA:/root/media/outbound/word-audio.mp3", "audio"],
    ["mp3 相对路径", "音频已生成 \nMEDIA:./word-audio.mp3", "audio"],
    ["pdf 绝对路径", "报告在这 \nMEDIA:/w/cet4.pdf", "document"],
    ["pdf 裸文件名", "报告在这 \nMEDIA:cet4.pdf", "document"],
    ["html 相对路径", "游戏好了 \nMEDIA:./lobster-invaders.html", "document"],
  ];
  for (const [name, raw, kind] of cases) {
    const split = splitMediaMarkers(raw);
    ok(`${name} ⇒ 恰好提取 1 条`, split.media.length === 1, split.media);
    ok(`${name} ⇒ 正文不再残留 MEDIA:`, !split.text.includes("MEDIA:"), JSON.stringify(split.text));
    const att = split.media[0] !== undefined ? inferMediaAttachment(split.media[0]) : null;
    ok(`${name} ⇒ 归类 ${kind}`, att?.kind === kind, att);
  }
}
console.log("\n[13] 行内 `MEDIA:` —— 模型把引用写在列表项里（预发实测：附件不出、正文还留脏文本）");
{
  // 现场原文（预发截图）：`MEDIA:` 不在行首，而是跟在 `- **PDF 版**：` 之后。
  // 上游 src/media/parse.ts:544 只认行首（那是投递语义），客户端渲染层放宽一档。
  const source = [
    "PDF 和 Word 都生成好了，直接下载：",
    "",
    "- **PDF 版**：MEDIA:/root/openclaw/media/outbound/resume-assistant/简历模板.pdf",
    "- **Word 版**：MEDIA:/root/openclaw/media/outbound/resume-assistant/简历模板.docx",
  ].join("\n");
  const split = splitMediaMarkers(source);
  ok("行内引用被识别（修复前 media 为空数组）", split.media.length === 2, split.media);
  ok("PDF 路径完整", split.media[0]?.endsWith("简历模板.pdf") === true, split.media[0]);
  ok("Word 路径完整", split.media[1]?.endsWith("简历模板.docx") === true, split.media[1]);
  ok("正文不再残留 MEDIA:", !split.text.includes("MEDIA:"), JSON.stringify(split.text));
  ok(
    "列表项前缀保留为可见文本",
    split.text.includes("- **PDF 版**：") && split.text.includes("- **Word 版**："),
    JSON.stringify(split.text),
  );
  // ⚠️ MIME_BY_EXT 不含 docx/doc/xlsx，别拿它当「是不是文件」的判断（踩过）。
  const docx = split.media[1] !== undefined ? inferMediaAttachment(split.media[1]) : null;
  ok("docx 仍归类为 document ⇒ 出下载卡片", docx?.kind === "document", docx);
}

console.log("\n[14] 行内 `MEDIA:` 的边界：宁可不出卡片，也绝不指向错误路径");
{
  const mustNotRender: Array<[string, string]> = [
    ["后跟说明文字", "- **PDF 版**：MEDIA:/root/x.pdf 这个文件你收好"],
    ["只有目录没有文件", "- 说明：MEDIA:/root/openclaw/media/outbound 是产物目录"],
    ["一行两个引用（上游正则贪婪会合并成一条）", "- 产物：MEDIA:/root/a.pdf 和 MEDIA:/root/b.pdf"],
    ["围栏内的示例", "```\nMEDIA:/root/x.pdf\n```"],
  ];
  for (const [name, raw] of mustNotRender) {
    const split = splitMediaMarkers(raw);
    ok(`${name} ⇒ 不出卡片`, split.media.length === 0, split.media);
  }

  const mustRender: Array<[string, string]> = [
    ["中文句号结尾", "- **PDF 版**：MEDIA:/root/openclaw/media/outbound/x.pdf。"],
    ["markdown 加粗闭合", "- **PDF 版**：MEDIA:/root/openclaw/media/outbound/x.pdf**"],
    ["含空格的本地路径", "- 文件：MEDIA:/tmp/openclaw/test image.png"],
    ["行内 docx", "- **Word 版**：MEDIA:/root/openclaw/media/outbound/x.docx"],
  ];
  for (const [name, raw] of mustRender) {
    const split = splitMediaMarkers(raw);
    ok(`${name} ⇒ 出卡片`, split.media.length === 1, split.media);
    ok(`${name} ⇒ 正文无 MEDIA: 残留`, !split.text.includes("MEDIA:"), JSON.stringify(split.text));
  }
}

console.log("\n[15] 行内 `MEDIA:` 的反例：不是投递、只是「在讲这个约定」");
{
  // 真实场景（本仓库会话里实测 24 处裸 `MEDIA:`，全属这一类）：模型在讲解 MEDIA 约定 /
  // 回显源码时，正文里会出现 `` `MEDIA:/x.mp3` ``。反引号 = 行内 code ⇒ 举例，不是投递。
  // 不加这道守卫的话，行内分支会把它解成卡片，凭空多出一个指向不存在文件的幽灵卡片。
  const mustNotRender: Array<[string, string]> = [
    [
      "单个行内 code span 包住引用",
      "正文里写 `MEDIA:/root/openclaw/media/outbound/x.mp3` 就会投递",
    ],
    ["行内 code 只包住 media 字面量", "行首独占一行的 `MEDIA:` 会被剥走，正文不留痕"],
    ["行内 code + 中文说明结尾", "注意 `MEDIA:/root/x.pdf` 这行的写法。"],
  ];
  for (const [name, raw] of mustNotRender) {
    const split = splitMediaMarkers(raw);
    ok(`${name} ⇒ 不出卡片`, split.media.length === 0, split.media);
    ok(`${name} ⇒ 正文原样保留`, split.text.includes("MEDIA:"), JSON.stringify(split.text));
  }

  // 反引号是**成对**的 ⇒ 当前位置不在 code span 内，照常解析（守卫不能误伤）
  const paired = "`--output` 参数：MEDIA:/root/openclaw/media/outbound/x.pdf";
  const pairedSplit = splitMediaMarkers(paired);
  ok("成对反引号（不在 code 内）⇒ 照常出卡片", pairedSplit.media.length === 1, pairedSplit.media);
  ok(
    "成对反引号 ⇒ 正文保留参数名、去掉引用",
    pairedSplit.text.includes("`--output` 参数：") && !pairedSplit.text.includes("MEDIA:"),
    JSON.stringify(pairedSplit.text),
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
