/**
 * 单元测试：外部 URL 白名单（`src/utils/openExternalUrl.ts`）。
 *
 * 为什么必须锁住：这是**唯一的注入防线**。附件/消息里的 URL 可能来自不受信来源，
 * 而它们会被写进 `href`；一旦放行 `javascript:` / `data:text/html` / `image/svg+xml`，
 * 用户点一下附件就执行了脚本 —— 而这类错误在界面上完全看不出来（点开「正常」打开一页）。
 *
 * 用例逐条对应上游 `ui/src/lib/open-external-url.test.ts`，另外补了大小写、
 * 无逗号、缺 baseHref 解析失败等边界。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:external`）
 */
import { isAllowedDataImageUrl, resolveSafeExternalUrl } from "@/utils/openExternalUrl";

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

const BASE = "https://openclaw.ai/chat";
const DATA_PNG = "data:image/png;base64,iVBORw0KGgo=";

console.log("\n[1] 放行：http / https / blob / 相对路径");
{
  ok(
    "绝对 https（query + hash 原样保留）",
    resolveSafeExternalUrl("https://example.com/a.png?x=1#y", BASE) ===
      "https://example.com/a.png?x=1#y",
  );
  ok(
    "http 也放行（内网/本地网关常见）",
    resolveSafeExternalUrl("http://127.0.0.1:18789/f.png", BASE) === "http://127.0.0.1:18789/f.png",
  );
  ok(
    "相对路径按 baseHref 绝对化",
    resolveSafeExternalUrl("/assets/pic.png", BASE) === "https://openclaw.ai/assets/pic.png",
  );
  ok(
    "blob:（附件预览走的就是它）",
    resolveSafeExternalUrl("blob:https://openclaw.ai/abc-123", BASE) ===
      "blob:https://openclaw.ai/abc-123",
  );
  ok(
    "大写 scheme 也算 https（协议判定大小写不敏感）",
    resolveSafeExternalUrl("HTTPS://EXAMPLE.COM/a.png", BASE) === "https://example.com/a.png",
    resolveSafeExternalUrl("HTTPS://EXAMPLE.COM/a.png", BASE),
  );
}

console.log("\n[2] data: 图片：仅显式开启时放行，且排除 SVG");
{
  ok(
    "allowDataImage 开启 → 放行 image/png",
    resolveSafeExternalUrl(DATA_PNG, BASE, { allowDataImage: true }) === DATA_PNG,
  );
  ok("未开启 → 拒绝（默认不放行任何 data:）", resolveSafeExternalUrl(DATA_PNG, BASE) === null);
  ok(
    "大写 MIME 也识别（IMAGE/PNG）",
    resolveSafeExternalUrl("data:IMAGE/PNG;base64,AAAA", BASE, { allowDataImage: true }) ===
      "data:IMAGE/PNG;base64,AAAA",
  );
  ok(
    "非图片 data: 拒绝（text/html 可执行脚本）",
    resolveSafeExternalUrl("data:text/html,<script>alert(1)</script>", BASE, {
      allowDataImage: true,
    }) === null,
  );
  ok(
    "SVG data: 拒绝（可内嵌 script）",
    resolveSafeExternalUrl("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />", BASE, {
      allowDataImage: true,
    }) === null,
  );
  ok(
    "base64 编码的 SVG 同样拒绝",
    resolveSafeExternalUrl(
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIC8+",
      BASE,
      { allowDataImage: true },
    ) === null,
  );
  ok(
    "大写 SVG MIME 也拒绝",
    resolveSafeExternalUrl("data:IMAGE/SVG+XML,%3Csvg/%3E", BASE, { allowDataImage: true }) ===
      null,
  );
  ok(
    "没有逗号的 data: 拒绝（结构不合法）",
    resolveSafeExternalUrl("data:image/png;base64", BASE, { allowDataImage: true }) === null,
  );
  ok(
    "逗号紧贴 data: 拒绝（无 MIME）",
    resolveSafeExternalUrl("data:,hello", BASE, { allowDataImage: true }) === null,
  );
}

console.log("\n[3] 拒绝：脚本 / 本地文件 / 其它 scheme / 空值");
{
  ok("javascript: 拒绝", resolveSafeExternalUrl("javascript:alert(1)", BASE) === null);
  ok("JaVaScRiPt: 大小写混写也拒绝", resolveSafeExternalUrl("JaVaScRiPt:alert(1)", BASE) === null);
  ok(
    "前导空格 + javascript: 拒绝（解析前先 trim）",
    resolveSafeExternalUrl("   javascript:alert(1)", BASE) === null,
  );
  ok("file: 拒绝", resolveSafeExternalUrl("file:///tmp/x.png", BASE) === null);
  ok("ftp: 拒绝（不在白名单）", resolveSafeExternalUrl("ftp://example.com/a.png", BASE) === null);
  ok("vbscript: 拒绝", resolveSafeExternalUrl("vbscript:msgbox(1)", BASE) === null);
  ok(
    "空串 / 纯空白 拒绝",
    resolveSafeExternalUrl("", BASE) === null && resolveSafeExternalUrl("   ", BASE) === null,
  );
  ok(
    "解析失败（baseHref 也非法）→ 拒绝",
    resolveSafeExternalUrl("https://example.com/a.png", "") === null,
  );
}

console.log("\n[4] isAllowedDataImageUrl 直接调用");
{
  ok("image/png → true", isAllowedDataImageUrl("data:image/png;base64,AA==") === true);
  ok("image/jpeg → true", isAllowedDataImageUrl("data:image/jpeg;base64,AA==") === true);
  ok("image/svg+xml → false", isAllowedDataImageUrl("data:image/svg+xml,<svg/>") === false);
  ok("非 data: → false", isAllowedDataImageUrl("https://example.com/a.png") === false);
  ok("text/plain → false", isAllowedDataImageUrl("data:text/plain,hi") === false);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
