/**
 * 单元测试：侧栏结构快照（`src/utils/sidebarSnapshot.ts`）。
 *
 * 这个模块决定「首屏能不能画出完整菜单」，而它的核心行为（TTL / 形状校验 /
 * 分桶合并 / 配额异常）全在浏览器里不容易构造，所以用假的 `localStorage` 驱动。
 *
 * 注意：必须**先**装好 `globalThis.window`，再动态 import 被测模块 ——
 * ESM 的静态 import 会被提升到前面执行。
 *
 * 运行：`npm run test:unit`
 */

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

// ── 假的 localStorage ──────────────────────────────────────────────────────
function makeStorage(opts: { throwOnSet?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
  } as Storage;
}

const storage = makeStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

const { readSidebarSnapshot, writeSidebarSnapshot, clearSidebarSnapshot } =
  await import("@/utils/sidebarSnapshot");

const GW = "ws://127.0.0.1:18789";
const OTHER = "ws://other.example.com";
const agent = (id: string) => ({ id });
const session = (key: string, updatedAt = 1000) => ({
  key,
  kind: "direct" as const,
  updatedAt,
  archived: false,
  pinned: false,
});

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[1] 基本读写");
{
  storage.clear();
  ok("没有快照 → null", readSidebarSnapshot(GW) === null);

  writeSidebarSnapshot(GW, {
    agents: [agent("main"), agent("cet4")],
    defaultId: "main",
    mainKey: "main",
  });
  const snap = readSidebarSnapshot(GW);
  ok("写入后能读回", snap !== null, snap);
  ok("agents 保留 2 条", snap?.agents.length === 2, snap?.agents.length);
  ok("defaultId 保留", snap?.defaultId === "main", snap?.defaultId);
  ok("sessions 此时为空数组", Array.isArray(snap?.sessions) && snap?.sessions.length === 0);

  // 第二个写入方（ChatSidebar）只写 sessions，不应把 agents 冲掉
  writeSidebarSnapshot(GW, {
    sessions: [session("agent:main:main"), session("agent:cet4:main", 2000)],
  });
  const merged = readSidebarSnapshot(GW);
  ok(
    "只写 sessions 时 agents 保留（分片合并）",
    merged?.agents.length === 2,
    merged?.agents.length,
  );
  ok("sessions 更新为 2 条", merged?.sessions.length === 2, merged?.sessions.length);
  ok("defaultId / mainKey 未被清掉", merged?.defaultId === "main" && merged?.mainKey === "main");

  ok("空 gatewayUrl → null / 写入被忽略", readSidebarSnapshot("") === null);
  writeSidebarSnapshot("", { agents: [agent("x")] });
  ok(
    "空 gatewayUrl 不会写入任何分桶",
    storage.getItem("openclaw.web.sidebarSnapshot.v1")?.includes('"x"') !== true,
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[2] 分桶：不同网关互不污染");
{
  storage.clear();
  writeSidebarSnapshot(GW, { agents: [agent("main")] });
  writeSidebarSnapshot(OTHER, { agents: [agent("ops"), agent("sales")] });
  ok("GW 只有 1 条", readSidebarSnapshot(GW)?.agents.length === 1);
  ok("OTHER 有 2 条", readSidebarSnapshot(OTHER)?.agents.length === 2);

  clearSidebarSnapshot(OTHER);
  ok("清掉 OTHER 后为 null", readSidebarSnapshot(OTHER) === null);
  ok("清掉 OTHER 不影响 GW", readSidebarSnapshot(GW)?.agents.length === 1);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[3] 形状校验：脏数据不能让首屏崩");
{
  storage.clear();
  const raw = {
    [GW]: {
      savedAt: Date.now(),
      defaultId: "main",
      mainKey: "main",
      // 混入各种非法项：非对象、缺 id/key、空串、null
      agents: [agent("main"), null, "x", { id: "" }, { id: "  " }, { id: "cet4" }],
      sessions: [
        session("agent:main:main"),
        { kind: "direct" },
        42,
        { key: "" },
        { key: "agent:cet4:main" },
      ],
    },
  };
  storage.setItem("openclaw.web.sidebarSnapshot.v1", JSON.stringify(raw));
  const snap = readSidebarSnapshot(GW);
  ok(
    "非法 agent 项被剔除（只留 main / cet4）",
    snap?.agents.length === 2,
    snap?.agents.map((a) => a.id),
  );
  ok(
    "非法 session 项被剔除（只留 2 条）",
    snap?.sessions.length === 2,
    snap?.sessions.map((s) => s.key),
  );

  storage.setItem("openclaw.web.sidebarSnapshot.v1", "{ not json");
  ok("JSON 解析失败 → null（不抛异常）", readSidebarSnapshot(GW) === null);

  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({ [GW]: { agents: [], sessions: [] } }),
  );
  ok("空内容快照视为无快照（避免既不骨架也不数据）", readSidebarSnapshot(GW) === null);

  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({ [GW]: { savedAt: 0, agents: [agent("a")] } }),
  );
  ok("savedAt 缺失/为 0 → 过期", readSidebarSnapshot(GW) === null);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[4] TTL：超过 7 天不再用于首屏");
{
  storage.clear();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({ [GW]: { savedAt: now - 6 * day, agents: [agent("main")], sessions: [] } }),
  );
  ok("6 天前 → 仍可用", readSidebarSnapshot(GW)?.agents.length === 1);

  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({ [GW]: { savedAt: now - 8 * day, agents: [agent("main")], sessions: [] } }),
  );
  ok("8 天前 → 视为过期", readSidebarSnapshot(GW) === null);

  // 写入时顺手清掉过期分桶
  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({
      [GW]: { savedAt: now - 8 * day, agents: [agent("old")], sessions: [] },
      [OTHER]: { savedAt: now, agents: [agent("fresh")], sessions: [] },
    }),
  );
  writeSidebarSnapshot(OTHER, { sessions: [session("agent:ops:main")] });
  const after = JSON.parse(storage.getItem("openclaw.web.sidebarSnapshot.v1") as string);
  ok("写入时清理过期分桶", !(GW in after) && OTHER in after, Object.keys(after));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[5] 上限与异常降级");
{
  storage.clear();
  writeSidebarSnapshot(GW, {
    agents: Array.from({ length: 80 }, (_, i) => agent(`a${i}`)),
    sessions: Array.from({ length: 300 }, (_, i) => session(`agent:a${i}:main`)),
  });
  const snap = readSidebarSnapshot(GW);
  ok("agents 截断到 50", snap?.agents.length === 50, snap?.agents.length);
  ok("sessions 截断到 200", snap?.sessions.length === 200, snap?.sessions.length);
}

{
  // setItem 抛配额异常时必须静默降级，不能让调用方崩
  const throwing = makeStorage({ throwOnSet: true });
  (globalThis as unknown as { window: unknown }).window = { localStorage: throwing };
  let threw = false;
  try {
    writeSidebarSnapshot(GW, { agents: [agent("main")] });
  } catch {
    threw = true;
  }
  ok("localStorage 抛异常时静默降级", threw === false);
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[6] identities：agent 名称/头像的首屏来源");
{
  storage.clear();
  // `agents.list` 的行里**没有** name/avatar（实测只有 id/workspace/agentRuntime/model），
  // 侧栏的名称与图标全靠 identity —— 不缓存的话首屏会先画首字母再翻转。
  writeSidebarSnapshot(GW, {
    agents: [agent("main"), agent("cet4")],
    identities: {
      main: {
        agentId: "main",
        name: "年间",
        avatar: "🐾",
        emoji: "🐾",
        avatarStatus: "none",
        avatarReason: "missing",
      },
    },
  });
  const snap = readSidebarSnapshot(GW);
  ok("identities 保留 main", snap?.identities.main?.name === "年间", snap?.identities);
  ok("identity.avatar 保留（emoji 形态）", snap?.identities.main?.avatar === "🐾");
  ok("identity.avatarStatus 保留", snap?.identities.main?.avatarStatus === "none");
  ok("未取到的 agent 不编造 identity", snap?.identities.cet4 === undefined);

  // 只写 sessions 时 identities 不能被冲掉（分片合并）
  writeSidebarSnapshot(GW, { sessions: [session("agent:main:main")] });
  ok("只写 sessions 时 identities 保留", readSidebarSnapshot(GW)?.identities.main?.name === "年间");

  // 只写 identities 时也不能把 agents / sessions 冲掉
  writeSidebarSnapshot(GW, { identities: { cet4: { agentId: "cet4", name: "四级" } } });
  const afterIdentity = readSidebarSnapshot(GW);
  ok(
    "只写 identities 时 agents 保留",
    afterIdentity?.agents.length === 2,
    afterIdentity?.agents.length,
  );
  ok("只写 identities 时 sessions 保留", afterIdentity?.sessions.length === 1);
  ok(
    "agents / identities 两个分片共存",
    afterIdentity?.identities.cet4?.name === "四级",
    afterIdentity?.identities,
  );

  // 形状校验：非对象丢弃、agentId 缺失时回落到键名、非法字段一律不落盘
  storage.clear();
  const raw = {
    [GW]: {
      savedAt: Date.now(),
      agents: [agent("main")],
      identities: {
        main: { name: "年间", avatar: "🐾" },
        cet4: null,
        ops: "not-an-object",
        "  ": { name: "空键" },
      },
    },
  };
  storage.setItem("openclaw.web.sidebarSnapshot.v1", JSON.stringify(raw));
  const dirty = readSidebarSnapshot(GW);
  ok(
    "identities 非法项被剔除（只留 main）",
    Object.keys(dirty?.identities ?? {}).join(",") === "main",
    dirty?.identities,
  );
  ok("agentId 缺失时用桶键补全", dirty?.identities.main?.agentId === "main");
  ok(
    "姓名/头像保留",
    dirty?.identities.main?.name === "年间" && dirty?.identities.main?.avatar === "🐾",
  );

  // 凭据类字段绝不能进 localStorage —— 走真实写入路径验证（读路径的校验另测）
  storage.clear();
  writeSidebarSnapshot(GW, {
    agents: [agent("main")],
    identities: {
      main: {
        agentId: "main",
        name: "年间",
        avatar: "🐾",
        token: "SECRET-TOKEN",
        avatarUrl: "/leak",
      } as never,
    },
  });
  ok(
    "身份缓存不落盘任何额外字段（token 被剥掉）",
    storage.getItem("openclaw.web.sidebarSnapshot.v1")?.includes("SECRET-TOKEN") !== true,
    storage.getItem("openclaw.web.sidebarSnapshot.v1"),
  );
  ok(
    "token / avatarUrl 不会出现在读回结果里",
    !("token" in (readSidebarSnapshot(GW)?.identities.main ?? {})) &&
      !("avatarUrl" in (readSidebarSnapshot(GW)?.identities.main ?? {})),
  );

  // 只有 identities（没有 agents/sessions）→ 没有列表可画，视为无快照
  storage.setItem(
    "openclaw.web.sidebarSnapshot.v1",
    JSON.stringify({
      [GW]: { savedAt: Date.now(), identities: { main: { agentId: "main", name: "年间" } } },
    }),
  );
  ok("只有 identities 不算有效快照", readSidebarSnapshot(GW) === null);

  // 空分桶上只写 identities → 不落盘（避免「有快照但画不出列表」）
  storage.clear();
  writeSidebarSnapshot(GW, { identities: { main: { agentId: "main", name: "年间" } } });
  ok("空分桶只写 identities 被忽略", readSidebarSnapshot(GW) === null);

  // identities 上限截断
  storage.clear();
  writeSidebarSnapshot(GW, {
    agents: [agent("main")],
    identities: Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`a${i}`, { agentId: `a${i}`, name: `n${i}` }]),
    ),
  });
  ok("identities 截断到 50", Object.keys(readSidebarSnapshot(GW)?.identities ?? {}).length === 50);
}

console.log(`\n==== sidebarSnapshot: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
