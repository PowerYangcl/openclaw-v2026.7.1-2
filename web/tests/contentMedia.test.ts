/**
 * 单元测试：消息 `content` 数组里的内嵌媒体块解析（`src/utils/contentMedia.ts`）。
 *
 * 为什么必须锁住：助手回复 / 工具结果里的图片与音频**只存在于 `content` 数组**里
 * （顶层 `MediaPaths` 只挂 user 轮次）。少读一种块形状，界面上就是「图片不显示 /
 * 音频没控件」，而且**没有任何报错**。
 *
 * 其中最重要的一条是 `omitted`：网关在把工具结果发给 Control UI 前会把图片 base64
 * 抹掉只留占位（`src/agents/embedded-agent-subscribe.tools.ts:257-262`），
 * 本文件**永远**要保证那种块不产出任何东西 —— 否则界面上会出现一张裂图，
 * 而将来大概率有人会「顺手修一下」把它变成真的裂图。
 *
 * 用例逐条对应上游 `ui/src/pages/chat/components/chat-message.ts` 的
 * `buildBase64ImageUrl` / `appendImageBlock` / `extractImages` /
 * `readPairingQrExpiresAtMs` / `isExpiredPairingQrBlock`，
 * 以及 `ui/src/lib/chat/message-normalizer.ts` 的 `attachment` 块形状。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:content-media`）
 */
import {
  buildBase64DataUrl,
  contentImageIsTranscriptMedia,
  contentImagesExcludingTranscriptMedia,
  contentMediaSafeHref,
  extractContentAttachments,
  extractContentImages,
  isExpiredPairingQrBlock,
  readPairingQrExpiresAtMs,
} from "@/utils/contentMedia";

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
const MP3 = "/Users/wangyongbo26/.openclaw/media/inbound/voice---a1b2c3d4.mp3";
const PDF = "/Users/wangyongbo26/.openclaw/media/inbound/report---99887766.pdf";
const MP4 = "/Users/wangyongbo26/.openclaw/media/inbound/clip---55443322.mp4";
const DATA_PNG = "data:image/png;base64,iVBORw0KGgo=";

console.log("\n[1] buildBase64DataUrl：已是 data: 原样，否则按 MIME 包一层");
{
  ok("裸 base64 + MIME", buildBase64DataUrl("AAA", "image/jpeg") === "data:image/jpeg;base64,AAA");
  ok(
    "裸 base64 无 MIME → 默认 image/png",
    buildBase64DataUrl("AAA") === "data:image/png;base64,AAA",
  );
  ok("已是 data: 原样返回（不二次包装）", buildBase64DataUrl(DATA_PNG, "image/jpeg") === DATA_PNG);
}

console.log("\n[2] 配对二维码过期判定");
{
  ok("expiresAtMs 是有限数 → 读出", readPairingQrExpiresAtMs({ expiresAtMs: 123 }) === 123);
  ok("缺失 → undefined", readPairingQrExpiresAtMs({}) === undefined);
  ok(
    "NaN / Infinity / 字符串 → undefined",
    readPairingQrExpiresAtMs({ expiresAtMs: Number.NaN }) === undefined &&
      readPairingQrExpiresAtMs({ expiresAtMs: Number.POSITIVE_INFINITY }) === undefined &&
      readPairingQrExpiresAtMs({ expiresAtMs: "123" }) === undefined,
  );
  ok("已过期 → true", isExpiredPairingQrBlock({ expiresAtMs: 100 }, 100) === true);
  ok("恰好到点算过期（<=）", isExpiredPairingQrBlock({ expiresAtMs: 100 }, 100) === true);
  ok("未到期 → false", isExpiredPairingQrBlock({ expiresAtMs: 200 }, 100) === false);
  ok("无过期时间视为永不过期", isExpiredPairingQrBlock({}, 1e15) === false);
}

console.log("\n[3] extractContentImages：能渲染的几种形态");
{
  ok(
    "image + source.base64（Anthropic 风格）",
    extractContentImages({
      content: [
        { type: "image", source: { type: "base64", data: "AAA", media_type: "image/jpeg" } },
      ],
    })[0]?.url === "data:image/jpeg;base64,AAA",
  );
  ok(
    "image + source.base64 无 media_type → 默认 image/png",
    extractContentImages({
      content: [{ type: "image", source: { type: "base64", data: "AAA" } }],
    })[0]?.url === "data:image/png;base64,AAA",
  );
  ok(
    "image + data（未过清洗的裸 base64）",
    extractContentImages({ content: [{ type: "image", data: "AAA", mimeType: "image/webp" }] })[0]
      ?.url === "data:image/webp;base64,AAA",
  );
  ok(
    "image + url",
    extractContentImages({ content: [{ type: "image", url: "https://x.com/a.png" }] })[0]?.url ===
      "https://x.com/a.png",
  );
  ok(
    "image + url 不重复产出",
    extractContentImages({ content: [{ type: "image", url: "https://x.com/a.png" }] }).length === 1,
  );
  ok(
    "image_url（OpenAI 风格）",
    extractContentImages({
      content: [{ type: "image_url", image_url: { url: "https://x.com/b.png" } }],
    })[0]?.url === "https://x.com/b.png",
  );
  ok(
    "image_url 形状不对（image_url 是字符串）→ 不产出",
    extractContentImages({ content: [{ type: "image_url", image_url: "https://x.com/b.png" }] })
      .length === 0,
  );
  ok(
    "input_image + image_url 字符串",
    extractContentImages({
      content: [{ type: "input_image", image_url: "https://x.com/c.png" }],
    })[0]?.url === "https://x.com/c.png",
  );
  ok(
    "input_image + image_url 对象",
    extractContentImages({
      content: [{ type: "input_image", image_url: { url: "https://x.com/d.png" } }],
    })[0]?.url === "https://x.com/d.png",
  );
  ok(
    "input_image + source.url 兜底",
    extractContentImages({
      content: [{ type: "input_image", source: { url: "https://x.com/e.png" } }],
    })[0]?.url === "https://x.com/e.png",
  );
  ok(
    "input_image + source.data 兜底（转 data:）",
    extractContentImages({
      content: [{ type: "input_image", source: { data: "AAA", media_type: "image/gif" } }],
    })[0]?.url === "data:image/gif;base64,AAA",
  );
  ok(
    "input_image + source.data 无 media_type → 默认 image/png",
    extractContentImages({ content: [{ type: "input_image", source: { data: "AAA" } }] })[0]
      ?.url === "data:image/png;base64,AAA",
  );

  const withMeta = extractContentImages({
    content: [
      {
        type: "image",
        url: "https://x.com/a.png",
        alt: "登录页截图",
        openUrl: "https://x.com/full.png",
        width: 800,
        height: 600,
      },
    ],
  })[0];
  ok(
    "alt / openUrl / width / height 一并带出",
    withMeta?.alt === "登录页截图" &&
      withMeta?.openUrl === "https://x.com/full.png" &&
      withMeta?.width === 800 &&
      withMeta?.height === 600,
  );
  ok(
    "非法 width（字符串）不产出该字段",
    extractContentImages({ content: [{ type: "image", url: "u", width: "800" }] })[0]?.width ===
      undefined,
  );
}

console.log("\n[4] ⚠️ omitted：网关抹掉 base64 的占位块必须**什么都不产出**");
{
  // 形状逐字来自 src/agents/embedded-agent-subscribe.tools.ts:257-262 的清洗结果
  const cleaned = {
    type: "image",
    mimeType: "image/png",
    bytes: 123456,
    omitted: true,
  };
  const images = extractContentImages({ role: "toolResult", content: [cleaned] });
  ok("omitted 图片块不产出任何 image（否则界面出现裂图）", images.length === 0, images);
  ok(
    "omitted 块也不会退化成其它形态",
    extractContentImages({ content: [cleaned] }).every((i) => i.url !== ""),
  );

  const mixed = extractContentImages({
    content: [cleaned, { type: "text", text: "hi" }, { type: "image", url: "https://x.com/a.png" }],
  });
  ok(
    "同一条消息里 omitted 块被跳过、正常的仍产出",
    mixed.length === 1 && mixed[0]?.url === "https://x.com/a.png",
  );

  ok(
    "image 块三个分支都没有（无 source/base64、无 data、无 url）→ 不产出",
    extractContentImages({ content: [{ type: "image", mimeType: "image/png" }] }).length === 0,
  );
}

console.log("\n[5] 配对二维码块：过期过滤 + 形状");
{
  const fresh = {
    type: "openclaw_pairing_qr",
    image_url: DATA_PNG,
    alt: "扫码配对",
    expiresAtMs: 5_000,
  };
  ok("未过期 → 产出", extractContentImages({ content: [fresh] }, 1_000)[0]?.url === DATA_PNG);
  ok("alt 带出", extractContentImages({ content: [fresh] }, 1_000)[0]?.alt === "扫码配对");
  ok("已过期 → 不产出", extractContentImages({ content: [fresh] }, 6_000).length === 0);
  ok(
    "恰好到点 → 不产出（与 isExpiredPairingQrBlock 同一判据）",
    extractContentImages({ content: [fresh] }, 5_000).length === 0,
  );
  ok(
    "image_url 不是字符串 → 不产出",
    extractContentImages({ content: [{ type: "openclaw_pairing_qr", image_url: { url: "u" } }] })
      .length === 0,
  );
}

console.log("\n[6] extractContentImages：去重 / MediaPaths 并入 / 脏输入");
{
  const dup = extractContentImages({
    content: [
      { type: "image", url: "https://x.com/a.png" },
      { type: "image", url: "https://x.com/a.png" },
    ],
  });
  ok("同 url 同 alt 去重（与上游 appendImageBlock 一致）", dup.length === 1, dup);

  const sameUrlDiffAlt = extractContentImages({
    content: [
      { type: "image", url: "https://x.com/a.png", alt: "A" },
      { type: "image", url: "https://x.com/a.png", alt: "B" },
    ],
  });
  ok("同 url 不同 alt 各留一条（与上游同口径）", sameUrlDiffAlt.length === 2, sameUrlDiffAlt);

  const withTop = extractContentImages({
    MediaPaths: [PNG, PDF],
    MediaTypes: ["image/png", "application/pdf"],
  });
  ok("顶层 MediaPaths 里的图片并入", withTop.length === 1 && withTop[0]?.url === PNG, withTop);
  ok(
    "顶层 MediaPaths 里的非图片不并入图片列表",
    withTop.every((i) => i.url !== PDF),
  );

  const both = extractContentImages({
    MediaPaths: [PNG],
    content: [{ type: "image", url: "https://x.com/a.png" }],
  });
  ok(
    "content 块与顶层 MediaPaths 同时存在 → 都产出",
    both.length === 2 &&
      both.some((i) => i.url === PNG) &&
      both.some((i) => i.url === "https://x.com/a.png"),
    both,
  );

  ok(
    "content 不是数组 → 只看 MediaPaths",
    extractContentImages({ content: "hi", MediaPaths: [PNG] }).length === 1,
  );
  ok(
    "content 数组里有脏值（null / 数字 / 字符串）不炸",
    (() => {
      try {
        return (
          extractContentImages({
            content: [null, 42, "x", { type: "image", url: "https://x.com/a.png" }],
          }).length === 1
        );
      } catch {
        return false;
      }
    })(),
  );
  ok("非对象输入 → []", extractContentImages(null).length === 0);
  ok("空对象 → []", extractContentImages({}).length === 0);
}

console.log("\n[7] extractContentAttachments：attachment 块");
{
  const att = extractContentAttachments({
    role: "assistant",
    content: [
      {
        type: "attachment",
        attachment: { url: PDF, kind: "document", label: "周报.pdf", mimeType: "application/pdf" },
      },
    ],
  });
  ok("attachment 块解析出 1 条", att.length === 1, att);
  ok("kind 原样", att[0]?.kind === "document");
  ok("url 原样", att[0]?.url === PDF);
  ok("label 用块里的", att[0]?.label === "周报.pdf");
  ok("mimeType 带出", att[0]?.mimeType === "application/pdf");

  ok(
    "label 为空 → 退回文件名",
    extractContentAttachments({
      content: [{ type: "attachment", attachment: { url: PDF, kind: "document", label: "   " } }],
    })[0]?.label === "report---99887766.pdf",
  );
  ok(
    "label 缺失 → 退回文件名",
    extractContentAttachments({ content: [{ type: "attachment", attachment: { url: PDF } }] })[0]
      ?.label === "report---99887766.pdf",
  );
  ok(
    "url 为空 → 不产出",
    extractContentAttachments({
      content: [{ type: "attachment", attachment: { kind: "document" } }],
    }).length === 0,
  );
  ok(
    "attachment 字段不是对象 → 不产出",
    extractContentAttachments({ content: [{ type: "attachment", attachment: "x" }] }).length === 0,
  );
  ok(
    "同 url 同 kind 去重",
    (() => {
      const block = { type: "attachment", attachment: { url: PDF, kind: "document" } };
      return extractContentAttachments({ content: [block, block] }).length === 1;
    })(),
  );
}

console.log("\n[8] extractContentAttachments：kind 归一");
{
  const kindOf = (url: string, kind?: unknown, mimeType?: string) =>
    extractContentAttachments({
      content: [
        {
          type: "attachment",
          attachment: {
            url,
            ...(kind !== undefined ? { kind } : {}),
            ...(mimeType ? { mimeType } : {}),
          },
        },
      ],
    })[0]?.kind;

  ok("显式 kind=audio 保留", kindOf("/tmp/x", "audio") === "audio");
  ok("显式 kind=video 保留", kindOf("/tmp/x", "video") === "video");
  ok("非法 kind + MIME audio/* → audio", kindOf("/tmp/x", "bogus", "audio/mpeg") === "audio");
  ok("非法 kind + MIME video/* → video", kindOf("/tmp/x", "bogus", "video/mp4") === "video");
  ok("无 kind 无 MIME + .mp3 → audio", kindOf("/tmp/x.mp3") === "audio");
  ok("无 kind 无 MIME + .mp4 → video", kindOf("/tmp/x.mp4") === "video");
  ok("其它 → document", kindOf("/tmp/x.bin") === "document");
  ok("MIME 与扩展名冲突时 MIME 优先", kindOf("/tmp/x.mp3", undefined, "video/mp4") === "video");
}

console.log("\n[9] extractContentAttachments：助手 audio 块（TTS）");
{
  ok(
    "assistant + audio(base64) → 转成音频附件并包 data:",
    extractContentAttachments({
      role: "assistant",
      content: [
        {
          type: "audio",
          label: "朗读",
          source: { type: "base64", data: "AAA", media_type: "audio/mpeg" },
        },
      ],
    })[0]?.url === "data:audio/mpeg;base64,AAA",
  );
  ok(
    "缺 media_type → 默认 audio/mpeg",
    extractContentAttachments({
      role: "assistant",
      content: [{ type: "audio", source: { type: "base64", data: "AAA" } }],
    })[0]?.url === "data:audio/mpeg;base64,AAA",
  );
  ok(
    "assistant + audio(url)",
    extractContentAttachments({
      role: "assistant",
      content: [{ type: "audio", source: { type: "url", url: "https://x.com/a.mp3" } }],
    })[0]?.url === "https://x.com/a.mp3",
  );
  ok(
    "label 用块里的",
    extractContentAttachments({
      role: "assistant",
      content: [
        { type: "audio", label: "朗读", source: { type: "url", url: "https://x.com/a.mp3" } },
      ],
    })[0]?.label === "朗读",
  );
  ok(
    "label 缺失 → 退回文件名",
    extractContentAttachments({
      role: "assistant",
      content: [{ type: "audio", source: { type: "url", url: "https://x.com/a.mp3" } }],
    })[0]?.label === "a.mp3",
  );
  ok(
    "kind 恒为 audio",
    extractContentAttachments({
      role: "assistant",
      content: [{ type: "audio", source: { type: "url", url: "https://x.com/a.mp3" } }],
    })[0]?.kind === "audio",
  );
  ok(
    "audio 块形状不对（无 source）→ 不产出",
    extractContentAttachments({ role: "assistant", content: [{ type: "audio", label: "x" }] })
      .length === 0,
  );
  ok(
    "⚠️ user 的 audio 块**不转附件**（上游 message-normalizer 单测明确要求）",
    extractContentAttachments({
      role: "user",
      content: [{ type: "audio", source: { type: "url", url: "https://x.com/a.mp3" } }],
    }).length === 0,
  );
}

console.log("\n[10] extractContentAttachments：顶层 MediaPaths 只对非 user 生效");
{
  ok(
    "assistant + MediaPaths 非图片 → 产出附件",
    extractContentAttachments({
      role: "assistant",
      MediaPaths: [MP3, PDF],
      MediaTypes: ["audio/mpeg", "application/pdf"],
    })
      .map((a) => a.kind)
      .join(",") === "audio,document",
  );
  ok(
    "assistant + MediaPaths 图片 → 不产出（图片走 extractContentImages）",
    extractContentAttachments({ role: "assistant", MediaPaths: [PNG], MediaTypes: ["image/png"] })
      .length === 0,
  );
  ok(
    "⚠️ user + MediaPaths → 完全不产出（已由气泡附件条渲染，再产出就重复）",
    extractContentAttachments({ role: "user", MediaPaths: [PDF], MediaTypes: ["application/pdf"] })
      .length === 0,
  );
  ok(
    "toolResult + MediaPaths → 产出",
    extractContentAttachments({ role: "toolResult", MediaPaths: [PDF] }).length === 1,
  );
  ok(
    "MediaPaths 条目的 label 是文件名",
    extractContentAttachments({ role: "assistant", MediaPaths: [PDF] })[0]?.label ===
      "report---99887766.pdf",
  );
  ok(
    "MediaPaths 条目带 mediaType",
    extractContentAttachments({
      role: "assistant",
      MediaPaths: [PDF],
      MediaTypes: ["application/pdf"],
    })[0]?.mimeType === "application/pdf",
  );
  ok("非对象 → []", extractContentAttachments(null).length === 0);
  ok("空对象 → []", extractContentAttachments({}).length === 0);
}

console.log("\n[11] 与气泡附件条去重（user 侧）");
{
  const record = {
    role: "user",
    content: [{ type: "image", url: PNG }],
    MediaPaths: [PNG],
    MediaTypes: ["image/png"],
  };
  const images = extractContentImages(record);
  ok("extractContentImages 会把 MediaPaths 的图片也并进来（旧版口径）", images.length === 1);
  ok(
    "contentImageIsTranscriptMedia 认出它来自顶层 MediaPaths",
    contentImageIsTranscriptMedia(images[0]!, record) === true,
  );
  ok(
    "contentImagesExcludingTranscriptMedia 滤掉它 → 不会重复渲染",
    contentImagesExcludingTranscriptMedia(record, images).length === 0,
  );

  const other = { role: "user", content: [{ type: "image", url: "https://x.com/a.png" }] };
  ok(
    "不是来自 MediaPaths 的图片保留",
    contentImagesExcludingTranscriptMedia(other, extractContentImages(other)).length === 1,
  );
}

console.log("\n[12] contentMediaSafeHref：渲染期白名单");
{
  ok("https 放行并绝对化", contentMediaSafeHref("https://x.com/a.png") === "https://x.com/a.png");
  ok("data:image/png 放行（allowDataImage 已开）", contentMediaSafeHref(DATA_PNG) === DATA_PNG);
  ok(
    "⚠️ data:image/svg+xml 一律拒绝（可内嵌脚本）",
    contentMediaSafeHref("data:image/svg+xml;base64,PHN2Zz4=") === null,
  );
  ok(
    "⚠️ data:text/html 拒绝",
    contentMediaSafeHref("data:text/html,<script>alert(1)</script>") === null,
  );
  ok("javascript: 拒绝", contentMediaSafeHref("javascript:alert(1)") === null);
  ok("空串 → null（调用方据此不渲染 href）", contentMediaSafeHref("") === null);
  ok(
    "站内相对路径按 baseHref 绝对化",
    contentMediaSafeHref("/__openclaw__/assistant-media?source=x", "http://127.0.0.1:18789/") ===
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=x",
  );
}

console.log("\n[13] 端到端：网关真实 payload 形状（含 omitted）");
{
  // 扫描本机 11 个会话实测到的形状：text / toolCall / image 三种块，图片块是 omitted 占位
  const realToolResult = {
    role: "toolResult",
    content: [
      { type: "text", text: "screenshot saved" },
      { type: "image", mimeType: "image/png", bytes: 50240, omitted: true },
    ],
  };
  ok(
    "真实 toolResult：没有任何可渲染图片（omitted 被跳过）",
    extractContentImages(realToolResult).length === 0,
  );
  ok("真实 toolResult：也没有可渲染附件", extractContentAttachments(realToolResult).length === 0);

  const realUser = {
    role: "user",
    content: [{ type: "text", text: "分析图中信息" }],
    MediaPath: PNG,
    MediaPaths: [PNG],
    MediaType: "image/png",
    MediaTypes: ["image/png"],
  };
  ok(
    "真实 user 轮次：图片来自顶层 MediaPaths",
    extractContentImages(realUser).length === 1 && extractContentImages(realUser)[0]?.url === PNG,
  );
  ok("真实 user 轮次：附件为 0（图片不算附件）", extractContentAttachments(realUser).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
