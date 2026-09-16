/**
 * 单元测试：附件（`src/utils/chatAttachments.ts`）。
 *
 * 为什么要有：`dataUrl → chat.send.attachments[]` 的换算**从界面上看不出对错**，
 * 而网关侧对形状很挑：
 *   - `content` 必须是**纯 base64**（带 `data:...;base64,` 前缀会被当成脏数据）；
 *   - `type` 必须是 `image` / `file`（网关按它决定内联成图片还是落盘成文件）；
 *   - 视频必须在**前端**就被滤掉（网关 `chat-attachments.ts` 会拒绝，报错晚一步）。
 * 这些一旦写错，表现是「消息发出去了但 agent 看不到图」，肉眼极难发现。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:attach`）
 */
import {
  buildApiAttachments,
  chatAttachmentFilesFromClipboard,
  chatAttachmentPreviewHref,
  cloneChatAttachmentMetadata,
  cloneChatAttachmentsMetadata,
  dataImageClipboardFile,
  discardChatAttachmentDataUrls,
  formatAttachmentSize,
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  isImageAttachment,
  isSupportedChatAttachmentFile,
  readChatAttachments,
  releaseChatAttachmentPayload,
  resetChatAttachmentPayloadStoreForTest,
  type ChatAttachment,
} from "@/utils/chatAttachments";

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

// ---- File / FileReader / URL 的最小替身（Node 里没有 DOM） ----

/** 手工构造的输入文件：`(name, type, size, payload)`。 */
class FakeFile {
  constructor(
    public name: string,
    public type: string,
    public size: number,
    private payload = "AAAA",
  ) {}
  text(): string {
    return this.payload;
  }
}

/**
 * `new File(parts, name, options)` 的标准形态 —— `dataImageClipboardFile`
 * 内部就是这么构造的，替身必须支持这个签名，否则会把 parts 当成 name。
 */
class FakeConstructedFile {
  name: string;
  type: string;
  size: number;
  constructor(parts: unknown[], name: string, options: { type?: string } = {}) {
    this.name = name;
    this.type = options.type ?? "";
    this.size = parts.reduce<number>(
      (total, part) => total + (ArrayBuffer.isView(part) ? part.byteLength : String(part).length),
      0,
    );
  }
  text(): string {
    return "";
  }
}

type FakeReader = {
  result: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

const readers: FakeReader[] = [];
class FakeFileReader {
  result = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private file: { name: string; type: string; text(): string } | null = null;
  constructor() {
    readers.push(this as unknown as FakeReader);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.onload = cb;
    if (type === "error") this.onerror = cb;
  }
  readAsDataURL(file: { name: string; type: string; text(): string }): void {
    this.file = file;
    this.result = `data:${file.type};base64,${file.text()}`;
    // 模拟异步：把回调排到微任务
    queueMicrotask(() => this.onload?.());
  }
}

const objectUrls: string[] = [];
const revoked: string[] = [];
let urlSeq = 0;

/**
 * ⚠️ 必须**继承真实的 `URL`**（不能塞一个 `{createObjectURL, revokeObjectURL}` 字面量）：
 * `chatAttachmentPreviewHref` 内部要 `new URL(candidate, base)` 做安全解析，
 * 字面量对象不是构造函数 → `TypeError: URL is not a constructor`，整段预览逻辑全挂。
 */
class FakeUrl extends URL {
  static createObjectURL(): string {
    urlSeq += 1;
    const url = `blob:fake/${urlSeq}`;
    objectUrls.push(url);
    return url;
  }
  static revokeObjectURL(url: string): void {
    revoked.push(url);
  }
}

(globalThis as unknown as { File: unknown }).File = FakeConstructedFile;
(globalThis as unknown as { FileReader: unknown }).FileReader = FakeFileReader;
(globalThis as unknown as { URL: unknown }).URL = FakeUrl;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
/** FakeFileReader 读出来的 dataURL：payload 是 FakeFile 的默认值 "AAAA"。 */
const FILE_PAYLOAD = "AAAA";
const FILE_DATA_URL = "data:image/png;base64,AAAA";

console.log("\n[1] 文件类型过滤：视频必须在前端被拒");
{
  const cases: Array<[string, string, boolean]> = [
    ["photo.png", "image/png", true],
    ["report.pdf", "application/pdf", true],
    ["data.csv", "text/csv", true],
    ["archive.zip", "application/zip", true],
    ["clip.mp4", "", false],
    ["movie.webm", "", false],
    ["clip.mov", "", false],
    ["x.mp4", "image/png", false], // mime 撒谎但扩展名是视频 → 仍拒绝
    ["weird", "video/quicktime", false], // 扩展名不认识但 mime 是视频 → 拒绝
  ];
  for (const [name, type, expected] of cases) {
    ok(
      `${name} (${type || "无 mime"}) → ${expected ? "接受" : "拒绝"}`,
      isSupportedChatAttachmentFile({ name, type }) === expected,
    );
  }
}

console.log("\n[2] 读取文件 → payload store → 预览地址 / base64 取回");
{
  resetChatAttachmentPayloadStoreForTest();
  const file = new FakeFile("photo.png", "image/png", 1234) as unknown as File;
  const atts = await readChatAttachments([file]);
  ok("读出一个附件", atts.length === 1, atts.length);
  const att = atts[0];
  ok(
    "元数据带 id / mimeType / fileName / sizeBytes",
    !!att.id &&
      att.mimeType === "image/png" &&
      att.fileName === "photo.png" &&
      att.sizeBytes === 1234,
    att,
  );
  ok("图片附件被识别为 image", isImageAttachment(att) === true);
  ok(
    "预览地址用 objectURL（不是 dataUrl 本体）",
    (getChatAttachmentPreviewUrl(att) ?? "").startsWith("blob:"),
    getChatAttachmentPreviewUrl(att),
  );
  ok(
    "dataUrl 只在 store 里，能从附件取回",
    getChatAttachmentDataUrl(att) === FILE_DATA_URL,
    getChatAttachmentDataUrl(att),
  );
  ok(
    "元数据副本不带 dataUrl / previewUrl",
    (() => {
      const meta = cloneChatAttachmentMetadata(att);
      return meta.dataUrl === undefined && meta.previewUrl === undefined && meta.id === att.id;
    })(),
    cloneChatAttachmentMetadata(att),
  );
  ok(
    "批量克隆与逐个克隆等价",
    JSON.stringify(cloneChatAttachmentsMetadata([att])) ===
      JSON.stringify([cloneChatAttachmentMetadata(att)]),
  );

  console.log("\n[3] 多选保序 + 视频被静默跳过（不抛错）");
  const multi = await readChatAttachments([
    new FakeFile("a.png", "image/png", 3) as unknown as File,
    new FakeFile("b.mp4", "video/mp4", 9) as unknown as File,
    new FakeFile("c.pdf", "application/pdf", 5) as unknown as File,
  ]);
  ok(
    "3 个里只剩 2 个（视频被跳过）",
    multi.length === 2,
    multi.map((a) => a.fileName),
  );
  ok(
    "顺序与选择顺序一致",
    multi.map((a) => a.fileName).join(",") === "a.png,c.pdf",
    multi.map((a) => a.fileName),
  );

  console.log("\n[4] chat.send 的 attachments 线格式");
  const api = buildApiAttachments([
    { id: "x1", mimeType: "image/png", fileName: "photo.png" } as ChatAttachment,
    { id: "x2", mimeType: "application/pdf", fileName: "doc.pdf" } as ChatAttachment,
  ]);
  // 上面两个附件没有登记 payload（手写的元数据），应当被丢弃 → undefined
  ok("取不到 payload 的附件被丢弃，返回 undefined", api === undefined, api);

  const att2 = (await readChatAttachments([
    new FakeFile("photo.png", "image/png", 3) as unknown as File,
    new FakeFile("doc.pdf", "application/pdf", 3) as unknown as File,
  ])) as ChatAttachment[];
  const api2 = buildApiAttachments(att2);
  ok("两个附件都产出", (api2 ?? []).length === 2, api2);
  ok("图片 → type=image", api2?.[0].type === "image", api2?.[0]);
  ok("PDF → type=file", api2?.[1].type === "file", api2?.[1]);
  ok(
    "content 是**纯 base64**（不带 data: 前缀 / 不带分号）",
    api2?.[0].content === FILE_PAYLOAD && !api2[0].content.includes("base64"),
    api2?.[0].content,
  );
  ok("fileName 透传", api2?.[1].fileName === "doc.pdf");
  ok("空数组 → undefined（不把空数组发给网关）", buildApiAttachments([]) === undefined);

  console.log("\n[5] 释放：移除附件时回收 objectURL");
  const previewUrl = getChatAttachmentPreviewUrl(att) ?? "";
  releaseChatAttachmentPayload(att.id);
  ok("objectURL 被 revoke", revoked.includes(previewUrl), { previewUrl, revoked });
  ok("释放后 store 里取不到 dataUrl", getChatAttachmentDataUrl(att) === null);
  // ⚠️ 调用方手里那份 `att` 上仍留着 previewUrl（与上游一致：`registerChatAttachmentPayload`
  // 会把 previewUrl 回写到元数据副本，供「已发送消息」的气泡继续显示缩略图）。
  // 所以判「store 已清空」必须用**不含 previewUrl 的元数据副本**去查，否则查的是本地字段。
  ok(
    "释放后 store 里取不到 previewUrl",
    getChatAttachmentPreviewUrl(cloneChatAttachmentMetadata(att)) === null,
    getChatAttachmentPreviewUrl(cloneChatAttachmentMetadata(att)),
  );
  ok(
    "重复释放是幂等的（不抛错、不再 revoke）",
    (() => {
      const before = revoked.length;
      releaseChatAttachmentPayload(att.id);
      return revoked.length === before;
    })(),
  );
  ok(
    "释放后 buildApiAttachments 丢弃该附件",
    buildApiAttachments([cloneChatAttachmentMetadata(att)]) === undefined,
  );
}

console.log("\n[5b] 发送成功后：丢 base64、留 objectURL（气泡缩略图还要用）");
{
  resetChatAttachmentPayloadStoreForTest();
  const sent = (await readChatAttachments([
    new FakeFile("shot.png", "image/png", 9) as unknown as File,
  ])) as ChatAttachment[];
  const preview = getChatAttachmentPreviewUrl(sent[0]) ?? "";
  discardChatAttachmentDataUrls(sent);
  ok("dataUrl 已丢弃", getChatAttachmentDataUrl(sent[0]) === null);
  ok(
    "objectURL 仍在（没被 revoke）",
    getChatAttachmentPreviewUrl(sent[0]) === preview && !revoked.includes(preview),
    { preview, revoked },
  );
  ok(
    "重复 discard 不抛错",
    (() => {
      discardChatAttachmentDataUrls(sent);
      return true;
    })(),
  );
}

console.log("\n[5c] 点击预览的安全地址（白名单在渲染期就挡住）");
{
  resetChatAttachmentPayloadStoreForTest();
  const BASE = "https://openclaw.ai/chat";

  const live = (await readChatAttachments([
    new FakeFile("a.png", "image/png", 3) as unknown as File,
  ])) as ChatAttachment[];
  ok(
    "活着的图片附件 → objectURL 直接可点",
    (chatAttachmentPreviewHref(live[0], BASE) ?? "").startsWith("blob:"),
    chatAttachmentPreviewHref(live[0], BASE),
  );

  const withUrl = (previewUrl: string): ChatAttachment => ({
    id: `u-${previewUrl}`,
    mimeType: "image/png",
    previewUrl,
  });
  ok(
    "http(s) 放行",
    chatAttachmentPreviewHref(withUrl("https://example.com/a.png"), BASE) ===
      "https://example.com/a.png",
  );
  ok(
    "相对路径按 baseHref 绝对化",
    chatAttachmentPreviewHref(withUrl("/assets/p.png"), BASE) ===
      "https://openclaw.ai/assets/p.png",
  );
  ok(
    "javascript: 一律拒绝",
    chatAttachmentPreviewHref(withUrl("javascript:alert(1)"), BASE) === null,
  );
  ok("file: 一律拒绝", chatAttachmentPreviewHref(withUrl("file:///tmp/x.png"), BASE) === null);
  ok("data:image/png 放行", chatAttachmentPreviewHref(withUrl(PNG), BASE) === PNG);
  ok(
    "data:image/svg+xml 拒绝（可内嵌脚本）",
    chatAttachmentPreviewHref(withUrl("data:image/svg+xml,<svg/>"), BASE) === null,
  );
  ok(
    "data:application/pdf 拒绝（非图片）",
    chatAttachmentPreviewHref(withUrl("data:application/pdf;base64,JVBERi0="), BASE) === null,
  );
  ok("空白 URL → null（不渲染成假链接）", chatAttachmentPreviewHref(withUrl("   "), BASE) === null);

  const dead = (await readChatAttachments([
    new FakeFile("gone.png", "image/png", 3) as unknown as File,
  ])) as ChatAttachment[];
  const metaOnly = cloneChatAttachmentMetadata(dead[0]);
  releaseChatAttachmentPayload(dead[0].id);
  ok(
    "payload 已释放 + 元数据副本（无 previewUrl）→ null，不再渲染成链接",
    chatAttachmentPreviewHref(metaOnly, BASE) === null,
    chatAttachmentPreviewHref(metaOnly, BASE),
  );
  // ⚠️ 已释放的 blob 地址在**浏览器侧**才失效（打开会是 404），前端查不出来。
  // 所以调用方释放 payload 时必须**同时把附件从列表里摘掉**（`attachments.value` /
  // 消息的 attachments），否则会留下一个「能点但打不开」的入口。
  ok(
    "（已知限制）手里那份带 previewUrl 的对象仍解析出已 revoke 的 blob 地址",
    chatAttachmentPreviewHref(dead[0], BASE) === dead[0].previewUrl,
    chatAttachmentPreviewHref(dead[0], BASE),
  );
}

console.log("\n[6] 剪贴板：image/* File 项与「图片 dataURL 文本」两条路径");
{
  const fakeFile = new FakeFile("pasted.png", "image/png", 4);
  const fromItems = chatAttachmentFilesFromClipboard({
    items: [
      { type: "image/png", getAsFile: () => fakeFile },
      { type: "text/plain", getAsFile: () => null },
    ],
    getData: () => "",
  } as unknown as DataTransfer);
  ok(
    "items 里的图片项被取出",
    fromItems.length === 1 && fromItems[0] === (fakeFile as unknown as File),
  );

  const fromText = chatAttachmentFilesFromClipboard({
    items: [],
    getData: () => PNG,
  } as unknown as DataTransfer);
  ok("回退路径：图片 dataURL 文本 → 1 个 File", fromText.length === 1, fromText.length);
  ok(
    "回退出来的文件带正确扩展名",
    fromText[0]?.name === "pasted-image.png" && fromText[0]?.type === "image/png",
    fromText[0] && { name: fromText[0].name, type: fromText[0].type },
  );

  const none = chatAttachmentFilesFromClipboard({
    items: [],
    getData: () => "hello",
  } as unknown as DataTransfer);
  ok("纯文本粘贴不会变成附件", none.length === 0, none.length);

  ok(
    "dataImageClipboardFile 拒绝非图片 dataURL",
    dataImageClipboardFile("data:text/plain;base64,aGk=") === null,
  );
  ok(
    "dataImageClipboardFile 拒绝非法 base64 结构",
    dataImageClipboardFile("data:image/png,notbase64") === null,
  );
}

console.log("\n[7] 体积文案");
{
  ok("512 → 512 B", formatAttachmentSize(512) === "512 B", formatAttachmentSize(512));
  ok("2048 → 2.0 KB", formatAttachmentSize(2048) === "2.0 KB", formatAttachmentSize(2048));
  ok("3MiB → 3.0 MB", formatAttachmentSize(3 * 1024 * 1024) === "3.0 MB");
  ok(
    "0 / undefined → 空串（不渲染 0 B）",
    formatAttachmentSize(0) === "" && formatAttachmentSize(undefined) === "",
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
