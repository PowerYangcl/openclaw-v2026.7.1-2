import { splitMediaMarkers } from "@/utils/mediaMarker";
/**
 * 单元测试：一轮助手产出「要不要落地 / 正文取哪个 / 哪些 role 该渲染」
 * （`src/utils/messageCommit.ts`）。
 *
 * 为什么必须锁住：这三件事以前散在 `ChatPane.vue` 的 `final` 分支里写成一行
 * `if (normalized && (normalized.text || normalized.thinking))`，而**只回一个 mp3**
 * 的那一轮，正文里的 `MEDIA:` 行被 `normalizeMessage` 剥走之后 `text` 就是空串
 * ⇒ 掉进兜底分支 ⇒ 生成一条没有 `contentAttachments` 的手搓消息
 * ⇒ 用户必须刷新页面（走 `loadHistory` 的 normalize）才能看到下载按钮 / `<audio>`。
 *
 * 本套件把「纯媒体回复」这条分支钉死，将来谁把媒体从判定里拿掉都会立刻红。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:commit`）
 */
import {
  hasVisibleMessageContent,
  isRenderableMessageRole,
  resolveCommittedText,
  shouldAdoptStreamedMedia,
  type NormalizedAssistantLike,
} from "@/utils/messageCommit";

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

console.log("\n[1] 本次 bug 的现场：整条回复只有一个 mp3");
{
  // 助手把语音交出来的方式：正文里写一行 MEDIA:<路径>，消息字段里没有任何 media 字段。
  const raw = "MEDIA:/root/media/outbound/tts/2026.09.15-回复.mp3";
  const split = splitMediaMarkers(raw);
  ok("MEDIA 行被剥离出来", split.media.length === 1, split.media);
  ok("剥完之后正文是空串（← 以前就栽在这）", split.text === "", JSON.stringify(split.text));

  const normalized: NormalizedAssistantLike = {
    text: split.text,
    contentAttachments: [{ url: split.media[0]!, kind: "audio" }],
  };
  // 这是核心断言：以前这里返回 false，消息就掉进手搓对象的兜底分支，
  // 附件位（下载卡片 / <audio> 播放器）根本不存在 —— 刷新后才出现。
  ok("空正文 + 有媒体 ⇒ 仍然算「有可见内容」", hasVisibleMessageContent(normalized));
}

console.log("\n[2] hasVisibleMessageContent：各类产物判定");
{
  ok(
    "null / undefined ⇒ false",
    !hasVisibleMessageContent(null) && !hasVisibleMessageContent(undefined),
  );
  ok("空对象 ⇒ false", !hasVisibleMessageContent({}));
  ok("有正文 ⇒ true", hasVisibleMessageContent({ text: "你好" }));
  ok("有思考 ⇒ true", hasVisibleMessageContent({ thinking: "想想" }));
  ok("有图片 ⇒ true", hasVisibleMessageContent({ contentImages: [{ url: "/a.png" }] }));
  ok("有附件 ⇒ true", hasVisibleMessageContent({ contentAttachments: [{ url: "/a.mp3" }] }));
  ok(
    "有顶层 MediaPaths ⇒ true",
    hasVisibleMessageContent({ historyMedia: [{ source: "/a.mp3" }] }),
  );
  ok("空数组不算内容", !hasVisibleMessageContent({ contentImages: [], contentAttachments: [] }));
}

console.log("\n[3] resolveCommittedText：纯媒体回复不能回落到流式正文");
{
  const streamedText = "MEDIA:/root/media/outbound/tts/a.mp3";
  const normalizedOnlyMedia = {
    text: "",
    contentAttachments: [{ url: "/root/media/outbound/tts/a.mp3", kind: "audio" }],
  };
  ok(
    "有媒体时：正文为空就保持为空，绝不把 `MEDIA:` 原文贴回去",
    resolveCommittedText(normalizedOnlyMedia, streamedText) === "",
    JSON.stringify(resolveCommittedText(normalizedOnlyMedia, streamedText)),
  );

  const normalizedWithText = {
    text: "语音合成好了 👇",
    contentAttachments: [{ url: "/root/media/outbound/tts/a.mp3", kind: "audio" }],
  };
  ok(
    "有媒体且有正文：取 normalized 的正文",
    resolveCommittedText(normalizedWithText, "whatever") === "语音合成好了 👇",
  );

  const normalizedNoTextNoMedia = { text: "" };
  ok(
    "没媒体、正文为空 ⇒ 回落流式正文（final 帧缺 text 的老兜底）",
    resolveCommittedText(normalizedNoTextNoMedia, "流式攒下来的正文") === "流式攒下来的正文",
  );
  ok("没媒体且流式正文也为空 ⇒ 空串", resolveCommittedText(normalizedNoTextNoMedia, "") === "");
  ok("normalized 为 null ⇒ 回落流式正文", resolveCommittedText(null, "abc") === "abc");
}

console.log("\n[4] isRenderableMessageRole：各角色均渲染（system 已按参考页改为可见）");
{
  ok("user 渲染", isRenderableMessageRole("user"));
  ok("assistant 渲染", isRenderableMessageRole("assistant"));
  ok("system 渲染（对齐参考页：作为通用气泡展示）", isRenderableMessageRole("system"));
  ok("缺失 role 视为可渲染（历史数据兜底）", isRenderableMessageRole(undefined));
  // 刻意**不**隐藏 toolResult：工具结果卡片还没移植，藏了就彻底看不见。
  ok(
    "toolResult 仍然渲染（已在 ChatPane 渲染成可折叠 Activity 卡片，别把它一起藏掉）",
    isRenderableMessageRole("toolResult"),
  );
}

console.log("\n[5] shouldAdoptStreamedMedia：final 帧丢了 `MEDIA:` 行时用流式正文补媒体位");
{
  const noMedia: NormalizedAssistantLike = { text: "报告已生成" };
  ok("final 无媒体 + 流式有媒体 ⇒ 补", shouldAdoptStreamedMedia(noMedia, 1));
  ok(
    "final 已有媒体 ⇒ 不补（绝不覆盖服务端数据）",
    !shouldAdoptStreamedMedia({ text: "", contentAttachments: [{ url: "/a.html" }] }, 1),
  );
  ok("流式没有媒体 ⇒ 不补", !shouldAdoptStreamedMedia(noMedia, 0));
  ok("final 为 null 且流式有媒体 ⇒ 补", shouldAdoptStreamedMedia(null, 1));
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
