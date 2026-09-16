/**
 * 单元测试：历史消息的媒体附件解析（`src/utils/transcriptMedia.ts`）。
 *
 * 为什么必须锁住：这是**「刷新后附件还在不在」的唯一开关**。网关 `chat.history` 的 user
 * 消息顶层带 `MediaPath(s)`/`MediaType(s)`，一旦这里少读一个字段、或把
 * `application/octet-stream` 那条回退分支删掉，历史里的图片就会静默退化成文件卡片
 * （或者更糟：连卡片都没有）—— 界面上只表现为「附件没了」，完全看不出是哪一步断的。
 *
 * 用例逐条对应上游 `ui/src/pages/chat/components/chat-message.ts` 的
 * `getFileExtension` / `isImageTranscriptMediaPath` / `isAudioTranscriptMediaPath` /
 * `labelForMediaPath` / `extractTranscriptMediaEntries`（含 octet-stream 回退这条边界）。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:media-history`）
 */
import {
  extractTranscriptMediaItems,
  getMediaFileExtension,
  isAudioTranscriptMediaPath,
  isImageTranscriptMediaPath,
  isVideoTranscriptMediaPath,
  labelForMediaPath,
  readTranscriptMediaPaths,
  readTranscriptMediaTypes,
  transcriptMediaKind,
} from "@/utils/transcriptMedia";

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

const PNG = "/Users/wangyongbo26/.openclaw/media/inbound/shot---6b3737d9.png";
const MD = "/Users/wangyongbo26/.openclaw/media/inbound/方案---28719d98.md";

console.log("\n[1] readTranscriptMediaPaths：数组优先 / 单数兜底 / 过滤脏值");
{
  ok(
    "MediaPaths 数组",
    JSON.stringify(readTranscriptMediaPaths({ MediaPaths: [PNG, MD] })) ===
      JSON.stringify([PNG, MD]),
  );
  ok(
    "只有 MediaPath 单数",
    JSON.stringify(readTranscriptMediaPaths({ MediaPath: PNG })) === JSON.stringify([PNG]),
  );
  ok(
    "MediaPaths 优先于 MediaPath",
    JSON.stringify(readTranscriptMediaPaths({ MediaPaths: [MD], MediaPath: PNG })) ===
      JSON.stringify([MD]),
  );
  ok(
    "数组里的非字符串被剔除",
    JSON.stringify(readTranscriptMediaPaths({ MediaPaths: [PNG, 42, null, {}] })) ===
      JSON.stringify([PNG]),
  );
  ok(
    "空串 / 纯空白被剔除",
    JSON.stringify(readTranscriptMediaPaths({ MediaPaths: ["", "   ", PNG] })) ===
      JSON.stringify([PNG]),
  );
  ok("两个字段都没有 → []", JSON.stringify(readTranscriptMediaPaths({ content: "hi" })) === "[]");
  ok("非对象输入 → []", JSON.stringify(readTranscriptMediaPaths(null)) === "[]");
  ok(
    "空数组 MediaPaths 不回落到 MediaPath（与上游一致：数组优先即定型）",
    JSON.stringify(readTranscriptMediaPaths({ MediaPaths: [], MediaPath: PNG })) === "[]",
  );
}

console.log("\n[2] readTranscriptMediaTypes：下标与 paths 对齐");
{
  ok(
    "MediaTypes 数组",
    JSON.stringify(readTranscriptMediaTypes({ MediaTypes: ["image/png"] })) ===
      JSON.stringify(["image/png"]),
  );
  ok(
    "MediaType 单数",
    JSON.stringify(readTranscriptMediaTypes({ MediaType: "text/markdown" })) ===
      JSON.stringify(["text/markdown"]),
  );
  ok("都没有 → []", JSON.stringify(readTranscriptMediaTypes({})) === "[]");
}

console.log("\n[3] getMediaFileExtension");
{
  ok("本地绝对路径", getMediaFileExtension(PNG) === "png");
  ok("大写扩展名归一为小写", getMediaFileExtension("/tmp/A.PNG") === "png");
  ok(
    "https URL 走 pathname（query 不干扰）",
    getMediaFileExtension("https://x.com/a/b/report.pdf?token=abc#frag") === "pdf",
  );
  ok("无扩展名 → undefined", getMediaFileExtension("/tmp/README") === undefined);
  ok("空串 → undefined", getMediaFileExtension("") === undefined);
  ok(
    "中文文件名不影响取扩展名",
    getMediaFileExtension("/Users/x/media/inbound/上下文之前显示---e8fd3eb5.png") === "png",
  );
}

console.log("\n[4] isImageTranscriptMediaPath");
{
  ok("mediaType 是 image/* → true", isImageTranscriptMediaPath("/tmp/x", "image/png") === true);
  ok(
    "mediaType 是 image/* 且大写 → true",
    isImageTranscriptMediaPath("/tmp/x.dat", "IMAGE/JPEG") === true,
  );
  ok(
    "mediaType 明确非图片（text/markdown）→ false，即便扩展名像图片",
    isImageTranscriptMediaPath("/tmp/x.png", "text/markdown") === false,
  );
  ok(
    "**application/octet-stream 必须回退到扩展名** → true（关键分支）",
    isImageTranscriptMediaPath("/tmp/x.png", "application/octet-stream") === true,
  );
  ok(
    "octet-stream + 非图片扩展名 → false",
    isImageTranscriptMediaPath("/tmp/x.pdf", "application/octet-stream") === false,
  );
  ok("mediaType 缺失时按扩展名", isImageTranscriptMediaPath("/tmp/x.webp") === true);
  ok("mediaType 为空白串视同缺失", isImageTranscriptMediaPath("/tmp/x.heic", "   ") === true);
  ok("扩展名不在图片白名单 → false", isImageTranscriptMediaPath("/tmp/x.pdf", undefined) === false);
  ok(
    "svg 也算图片（此处不做脚本过滤，安全由 URL 白名单负责）",
    isImageTranscriptMediaPath("/tmp/x.svg") === true,
  );
  ok("无扩展名且无 mediaType → false", isImageTranscriptMediaPath("/tmp/README") === false);
}

console.log("\n[5] isAudioTranscriptMediaPath");
{
  ok("audio/* → true", isAudioTranscriptMediaPath("/tmp/x", "audio/mpeg") === true);
  ok("扩展名 mp3 → true", isAudioTranscriptMediaPath("/tmp/x.mp3") === true);
  ok(
    "wav/opus/ogg/m4a 都在白名单",
    ["wav", "opus", "ogg", "m4a", "flac"].every((ext) =>
      isAudioTranscriptMediaPath(`/tmp/x.${ext}`),
    ),
  );
  ok("图片不算音频", isAudioTranscriptMediaPath("/tmp/x.png", "image/png") === false);
  ok("无扩展名 → false", isAudioTranscriptMediaPath("/tmp/README") === false);
}

console.log("\n[5b] isVideoTranscriptMediaPath");
{
  ok("video/* → true", isVideoTranscriptMediaPath("/tmp/x", "video/mp4") === true);
  ok("大小写归一", isVideoTranscriptMediaPath("/tmp/x", "VIDEO/MP4") === true);
  ok("扩展名 mp4 → true", isVideoTranscriptMediaPath("/tmp/x.mp4") === true);
  ok(
    "mov/webm/m4v 都在白名单",
    ["mov", "webm", "m4v"].every((ext) => isVideoTranscriptMediaPath(`/tmp/x.${ext}`)),
  );
  ok("音频不算视频", isVideoTranscriptMediaPath("/tmp/x.mp3", "audio/mpeg") === false);
  ok("图片不算视频", isVideoTranscriptMediaPath("/tmp/x.png", "image/png") === false);
  ok("无扩展名无 MIME → false", isVideoTranscriptMediaPath("/tmp/README") === false);
}

console.log("\n[6] transcriptMediaKind 四分类");
{
  ok("png → image", transcriptMediaKind(PNG, "image/png") === "image");
  ok("md（text/markdown）→ document", transcriptMediaKind(MD, "text/markdown") === "document");
  ok("mp3 → audio", transcriptMediaKind("/tmp/x.mp3", "audio/mpeg") === "audio");
  ok("mp4 → video", transcriptMediaKind("/tmp/x.mp4", "video/mp4") === "video");
  ok("扩展名 mp4 无 MIME → video", transcriptMediaKind("/tmp/x.mp4") === "video");
  ok(
    "octet-stream + png 扩展名 → image（回退生效）",
    transcriptMediaKind("/tmp/x.png", "application/octet-stream") === "image",
  );
  ok("无扩展名无 MIME → document", transcriptMediaKind("/tmp/README") === "document");
  ok(
    "media://inbound/<id> 无扩展名 → document",
    transcriptMediaKind("media://inbound/abc", undefined) === "document",
  );
}

console.log("\n[7] labelForMediaPath");
{
  ok("本地路径取文件名", labelForMediaPath(PNG) === "shot---6b3737d9.png");
  ok(
    "中文文件名原样保留",
    labelForMediaPath("/Users/x/media/inbound/上下文之前显示---e8fd3eb5.png") ===
      "上下文之前显示---e8fd3eb5.png",
  );
  ok(
    "https URL 取 pathname 末段",
    labelForMediaPath("https://x.com/a/b/report.pdf?token=abc") === "report.pdf",
  );
  ok(
    "Windows 反斜杠路径也能切",
    labelForMediaPath("C:\\Users\\x\\media\\inbound\\shot.png") === "shot.png",
  );
  ok("空串 → 空串", labelForMediaPath("") === "");
  ok(
    "结尾斜杠：末段为空 → 回退用整串（与上游同一分支）",
    labelForMediaPath("/tmp/dir/") === "/tmp/dir/",
  );
}

console.log("\n[8] extractTranscriptMediaItems 端到端（网关真实载荷形状）");
{
  const real = {
    role: "user",
    content: "分析图中信息",
    MediaPath: PNG,
    MediaPaths: [PNG],
    MediaType: "image/png",
    MediaTypes: ["image/png"],
  };
  const items = extractTranscriptMediaItems(real);
  ok("解析出 1 条", items.length === 1, items);
  ok("kind = image", items[0]?.kind === "image");
  ok("source 原样保留（含中文/全路径，取字节时要用）", items[0]?.source === PNG);
  ok("label 是文件名", items[0]?.label === "shot---6b3737d9.png");
  ok("key = source（去重键）", items[0]?.key === PNG);
  ok("mediaType 保留", items[0]?.mediaType === "image/png");

  const multi = extractTranscriptMediaItems({
    MediaPaths: [PNG, MD],
    MediaTypes: ["image/png", "text/markdown"],
  });
  ok("多附件按顺序", multi.map((i) => i.kind).join(",") === "image,document", multi);

  const typesShorter = extractTranscriptMediaItems({
    MediaPaths: [PNG, MD],
    MediaTypes: ["image/png"],
  });
  ok(
    "MediaTypes 比 paths 短：多出来的一条不丢，走扩展名判断",
    typesShorter.length === 2 && typesShorter[1]?.kind === "document",
    typesShorter,
  );
  ok("缺 MIME 的条目 mediaType 为 undefined", typesShorter[1]?.mediaType === undefined);

  const dup = extractTranscriptMediaItems({ MediaPaths: [PNG, PNG] });
  ok("同一路径重复引用只留一条（与上游 appendImageBlock 去重一致）", dup.length === 1, dup);

  ok("没有 media 字段 → []", extractTranscriptMediaItems({ content: "hi" }).length === 0);
  ok("非对象 → []", extractTranscriptMediaItems(null).length === 0);
  ok("MediaPaths 全脏值 → []", extractTranscriptMediaItems({ MediaPaths: ["", 7] }).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
