import {
  buildAssistantMediaUrl,
  extractAudioReferences,
  formatAudioTime,
  isLocalMediaSource,
} from "@/utils/assistantMedia";
/**
 * 单元测试：头像 / 音频地址构造（`src/utils/avatar.ts` + `src/utils/assistantMedia.ts`）。
 *
 * 为什么必须有：这两个模块都踩过**同一个真 bug** ——
 * 「先把站内路径绝对化成 `http://gw/...`，再交给只认 `startsWith('/')` 的守卫补 token」，
 * 守卫静默跳过，token 丢失 → 网关 401 → 头像破图 / 音频加载失败。
 * 浏览器里只看到「源是对的、但就是 401」，极难定位。这里用纯函数把两个分支钉死。
 *
 * 运行：`npm run test:unit`
 */
import {
  looksLikeFilesystemPath,
  resolveAvatarImageSrc,
  resolveGatewayAssetUrl,
  resolveGatewayHttpBase,
} from "@/utils/avatar";

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

const GW = "http://127.0.0.1:18789";
const TOKEN = "tok-abc123";

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[1] resolveGatewayHttpBase：WS 地址 → 网关 HTTP 源");
{
  ok(
    "ws → http",
    resolveGatewayHttpBase("ws://127.0.0.1:18789") === GW,
    resolveGatewayHttpBase("ws://127.0.0.1:18789"),
  );
  ok("wss → https", resolveGatewayHttpBase("wss://gw.example.com") === "https://gw.example.com");
  ok(
    "保留 base path 并去尾斜杠",
    resolveGatewayHttpBase("wss://gw.example.com/openclaw/") === "https://gw.example.com/openclaw",
  );
  ok("空值 → 空串", resolveGatewayHttpBase("") === "" && resolveGatewayHttpBase(null) === "");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[2] looksLikeFilesystemPath：fs 路径不能被当成站内 URL");
{
  ok("/Users/xx/a.png", looksLikeFilesystemPath("/Users/xx/a.png"));
  ok("/root/media/outbound/a.mp3", looksLikeFilesystemPath("/root/media/outbound/a.mp3"));
  ok("file:///...", looksLikeFilesystemPath("file:///tmp/a.png"));
  ok("D:\\a.png", looksLikeFilesystemPath("D:\\a.png"));
  ok(
    "~/media/a.png 不是绝对 fs 路径（走 agent 路由兜底）",
    !looksLikeFilesystemPath("~/media/a.png"),
  );
  ok("/avatar/main 不是 fs 路径", !looksLikeFilesystemPath("/avatar/main"));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[3] resolveAvatarImageSrc：头像 <img src>");
{
  // 网关 agent.identity.get 实测返回的就是这个相对路由（avatarStatus:"local"）
  const fromRoute = resolveAvatarImageSrc({
    raw: "/avatar/main",
    gatewayBaseUrl: GW,
    token: TOKEN,
    status: "local",
    agentId: "main",
  });
  ok(
    "⭐ 站内路由 → 网关绝对地址 **且带 token**（回归：token 曾被静默丢弃）",
    fromRoute === `${GW}/avatar/main?token=${TOKEN}`,
    fromRoute,
  );

  const fromFsPath = resolveAvatarImageSrc({
    raw: "/Users/wangyongbo26/.openclaw/workspace/avatar-smoke.png",
    gatewayBaseUrl: GW,
    token: TOKEN,
    status: "local",
    agentId: "main",
  });
  ok(
    "fs 路径 → /avatar/<agentId> + token",
    fromFsPath === `${GW}/avatar/main?token=${TOKEN}`,
    fromFsPath,
  );

  ok(
    "fs 路径但没有 agentId → 空串（不猜 URL）",
    resolveAvatarImageSrc({ raw: "/Users/xx/a.png", gatewayBaseUrl: GW, token: TOKEN }) === "",
  );

  ok(
    "远端 URL 原样返回且绝不带 token（防凭据外泄）",
    resolveAvatarImageSrc({
      raw: "https://cdn.example.com/a.png",
      gatewayBaseUrl: GW,
      token: TOKEN,
    }) === "https://cdn.example.com/a.png",
  );

  ok(
    "data: URI 原样返回",
    resolveAvatarImageSrc({
      raw: "data:image/png;base64,AAA",
      gatewayBaseUrl: GW,
      token: TOKEN,
    }) === "data:image/png;base64,AAA",
  );

  ok(
    "协议相对 `//evil.com/x` 被拒绝（不能当站内地址补 token）",
    resolveAvatarImageSrc({ raw: "//evil.com/x.png", gatewayBaseUrl: GW, token: TOKEN }) === "",
  );

  ok(
    "base 为空时退回站内相对路径 + token（同源部署仍可用）",
    resolveAvatarImageSrc({ raw: "/avatar/main", gatewayBaseUrl: "", token: TOKEN }) ===
      `/avatar/main?token=${TOKEN}`,
  );

  ok(
    "base 为空且无 token → 原相对路径",
    resolveAvatarImageSrc({ raw: "/avatar/main", gatewayBaseUrl: "" }) === "/avatar/main",
  );

  ok(
    "base path 场景：/openclaw + /avatar/main → /openclaw/avatar/main",
    resolveAvatarImageSrc({
      raw: "/avatar/main",
      gatewayBaseUrl: "https://gw.example.com/openclaw",
      token: TOKEN,
    }) === `https://gw.example.com/openclaw/avatar/main?token=${TOKEN}`,
  );

  ok(
    "纯文本（emoji/单字）→ 空串，交给文本降级",
    resolveAvatarImageSrc({ raw: "🐾", gatewayBaseUrl: GW, token: TOKEN }) === "",
  );

  ok(
    "status=local 但值不可用 → 回落 /avatar/<agentId>",
    resolveAvatarImageSrc({
      raw: "有中文的值",
      gatewayBaseUrl: GW,
      token: TOKEN,
      status: "local",
      agentId: "main",
    }) === `${GW}/avatar/main?token=${TOKEN}`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[4] resolveGatewayAssetUrl 基础行为");
{
  ok("相对路径拼接", resolveGatewayAssetUrl(GW, "/a/b") === `${GW}/a/b`);
  ok("远端原样", resolveGatewayAssetUrl(GW, "https://x.com/a") === "https://x.com/a");
  ok("base 为空时原样返回路径", resolveGatewayAssetUrl("", "/a/b") === "/a/b");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[5] buildAssistantMediaUrl：音频地址");
{
  // 注意：query 由 URLSearchParams 生成，`~` 会编码成 %7E（与 encodeURIComponent 不同），
  // 所以断言要按「解析后的参数值」比较，而不是拼裸字符串。
  const queryOf = (url: string) => new URL(url).searchParams;

  const fsPath = "~/media/outbound/cet4/x.mp3";
  const fsUrl = buildAssistantMediaUrl({ source: fsPath, base: GW, token: TOKEN });
  ok(
    "fs 路径 → assistant-media?source= + token",
    fsUrl.startsWith(`${GW}/__openclaw__/assistant-media?`) &&
      queryOf(fsUrl).get("source") === fsPath &&
      queryOf(fsUrl).get("token") === TOKEN,
    fsUrl,
  );

  const ticketUrl = buildAssistantMediaUrl({
    source: "/tmp/a.mp3",
    base: GW,
    token: TOKEN,
    ticket: "v1.x.y",
  });
  ok(
    "有 mediaTicket 时优先用票据、不带 token",
    queryOf(ticketUrl).get("mediaTicket") === "v1.x.y" &&
      queryOf(ticketUrl).get("token") === null &&
      queryOf(ticketUrl).get("source") === "/tmp/a.mp3",
    ticketUrl,
  );

  ok(
    "file:// 前缀被剥掉",
    queryOf(buildAssistantMediaUrl({ source: "file:///tmp/a.mp3", base: GW, token: TOKEN })).get(
      "source",
    ) === "/tmp/a.mp3",
  );

  const managed = buildAssistantMediaUrl({
    source: "/media/outbound/cet4/x.mp3",
    base: GW,
    token: TOKEN,
  });
  ok(
    "⭐ 站内托管路径 /media/ → 直接绝对化 **且带 token**（回归：token 曾被静默丢弃）",
    managed === `${GW}/media/outbound/cet4/x.mp3?token=${TOKEN}`,
    managed,
  );

  const inbound = buildAssistantMediaUrl({
    source: "media://inbound/abc123",
    base: GW,
    token: TOKEN,
  });
  ok(
    "⭐ media://inbound/<id> → 走 ?source= 查询形态（不能拼在 base 后面）",
    inbound ===
      `${GW}/__openclaw__/assistant-media?source=${encodeURIComponent("media://inbound/abc123")}&token=${TOKEN}`,
    inbound,
  );

  ok(
    "远端 URL 原样返回",
    buildAssistantMediaUrl({ source: "https://x.com/a.mp3", base: GW, token: TOKEN }) ===
      "https://x.com/a.mp3",
  );
  ok("空 source → 空串", buildAssistantMediaUrl({ source: "", base: GW, token: TOKEN }) === "");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[6] isLocalMediaSource：谁需要经网关取字节");
{
  ok("fs 路径 → true", isLocalMediaSource("/Users/xx/a.mp3"));
  ok("~/ 路径 → true", isLocalMediaSource("~/media/a.mp3"));
  ok("media://inbound → true（也要经网关）", isLocalMediaSource("media://inbound/a"));
  ok("站内托管路径 → false（可直出）", !isLocalMediaSource("/media/outbound/a.mp3"));
  ok(
    "/__openclaw__/assistant-media → false",
    !isLocalMediaSource("/__openclaw__/assistant-media?source=x"),
  );
  ok("远端 URL → false", !isLocalMediaSource("https://x.com/a.mp3"));
  ok("data: → false", !isLocalMediaSource("data:audio/mp3;base64,AA"));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[7] extractAudioReferences：从正文文本识别音频引用");
{
  const userExample = "文件路径：/root/media/outbound/cet4/2026.09.12背诵单词发音.mp3";
  const refs = extractAudioReferences(userExample);
  ok(
    "识别用户示例里的 mp3",
    refs.length === 1 && refs[0]!.raw === "/root/media/outbound/cet4/2026.09.12背诵单词发音.mp3",
    refs.map((r) => r.raw),
  );
  ok("label 取文件名", refs[0]!.label === "2026.09.12背诵单词发音.mp3", refs[0]!.label);

  const mixed = extractAudioReferences(
    "看这里 ~/media/outbound/cet4/a.mp3 和 https://cdn.x.com/b.wav，重复的 ~/media/outbound/cet4/a.mp3。还有 nope.txt",
  );
  ok(
    "多引用去重",
    mixed.length === 2,
    mixed.map((r) => r.raw),
  );
  ok(
    "http 音频也识别",
    mixed.some((r) => r.raw.startsWith("https://cdn.x.com")),
  );

  ok(
    "半角冒号紧跟路径时仍能切开（`路径:/root/a.mp3`）",
    extractAudioReferences("路径:/root/a.mp3").at(0)?.raw === "/root/a.mp3",
    extractAudioReferences("路径:/root/a.mp3").map((r) => r.raw),
  );

  ok(
    "多条 URL 并存都能识别",
    extractAudioReferences("a https://x.com/1.mp3 b https://y.com/2.wav").length === 2,
    extractAudioReferences("a https://x.com/1.mp3 b https://y.com/2.wav").map((r) => r.raw),
  );

  ok("非音频扩展名不识别", extractAudioReferences("这个是 readme.md 和 /tmp/a.txt").length === 0);
  ok("无路径前缀不识别（如裸 a.mp3）", extractAudioReferences("文件名是 a.mp3").length === 0);
  ok("句尾标点被剥离", extractAudioReferences("听 /tmp/a.mp3。").at(0)?.raw === "/tmp/a.mp3");
  ok(
    "超过 5 个时截断",
    extractAudioReferences([1, 2, 3, 4, 5, 6, 7].map((i) => `/tmp/a${i}.mp3`).join(" ")).length ===
      5,
  );
  ok("空文本 → 空数组", extractAudioReferences("").length === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[8] formatAudioTime");
{
  ok("0 → 0:00", formatAudioTime(0) === "0:00");
  ok("65 → 1:05", formatAudioTime(65) === "1:05");
  ok("61.9 → 1:01（向下取整）", formatAudioTime(61.9) === "1:01");
  ok("NaN → --:--", formatAudioTime(Number.NaN) === "--:--");
  ok("null → --:--", formatAudioTime(null) === "--:--");
  ok("负数 → --:--", formatAudioTime(-1) === "--:--");
  ok("Infinity → --:--", formatAudioTime(Number.POSITIVE_INFINITY) === "--:--");
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n=== mediaAndAvatarUrls: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
