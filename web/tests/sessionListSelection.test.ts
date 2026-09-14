import type { GatewaySessionRow } from "@/api/types";
/**
 * 单元测试：侧栏「每个 agent 一条代表会话」的选取逻辑（`src/utils/sessionListSelection.ts`）。
 *
 * 为什么要有这个测试：多 agent 的形态**在本机复现不了** —— 本机网关只有 1 个 agent
 * （`agents.list` 只返回 `main`），而线上是 `main` / `cet4` / `study-abroad-consultant`
 * 并存。所以把「选谁」的逻辑抽成纯函数，用用户截图里的真实形态在这里断言，
 * 浏览器冒烟只负责证明「组件确实接上了」。
 *
 * 运行：`npm run test:unit`
 * （用 Vite 自带的 esbuild 打包后交给 node 跑，不引入任何测试框架依赖。）
 */
import {
  buildSidebarSessionRows,
  eligibleSessionsForAgent,
  pickRepresentativeSession,
  qualifySessionKey,
  sessionKeysMatch,
} from "@/utils/sessionListSelection";

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

/** 统一构造网关会话行，避免逐字面量写全字段。 */
const row = (key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt: 1_000,
  archived: false,
  pinned: false,
  ...extra,
});

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[1] 用户截图形态：3 个 agent，每个都有 :main + :id-<hash> 并存");
{
  const agents = [{ id: "main" }, { id: "cet4" }, { id: "study-abroad-consultant" }];
  const sessions = [
    row("agent:cet4:main", { updatedAt: 500 }),
    row("agent:cet4:id-41db80fc", { updatedAt: 9000 }),
    row("agent:study-abroad-consultant:main", { updatedAt: 700 }),
    row("agent:study-abroad-consultant:id-9ab31c2e", { updatedAt: 8000 }),
    row("agent:main:main", { updatedAt: 600 }),
  ];
  const out = buildSidebarSessionRows({ agents, sessions, currentSessionKey: "agent:cet4:main" });
  const byAgent = new Map(out.map((r) => [r.key.split(":")[1], r.key]));

  ok(
    "恰好 3 行（不同 agent 并存、每个 agent 一条）",
    out.length === 3,
    out.map((r) => r.key),
  );
  ok("main → agent:main:main", byAgent.get("main") === "agent:main:main", byAgent.get("main"));
  ok(
    "cet4 → 当前会话 agent:cet4:main",
    byAgent.get("cet4") === "agent:cet4:main",
    byAgent.get("cet4"),
  );
  ok(
    "study-abroad → 规范 main（没被更新的 :id-9ab31c2e 顶掉）",
    byAgent.get("study-abroad-consultant") === "agent:study-abroad-consultant:main",
    byAgent.get("study-abroad-consultant"),
  );
  ok(
    "多余的 :id-<hash> 行不再铺开",
    !out.some((r) => r.key.includes("id-41db80fc") || r.key.includes("id-9ab31c2e")),
    out.map((r) => r.key),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[2] 当前会话真实存在且非 main → 当前会话优先（保证可见 + 可高亮）");
{
  const picked = pickRepresentativeSession({
    agentId: "cet4",
    sessions: [row("agent:cet4:main"), row("agent:cet4:id-41db80fc")],
    currentSessionKey: "agent:cet4:id-41db80fc",
  });
  ok("rule = current", picked.rule === "current", picked);
  ok("key = 当前会话", picked.key === "agent:cet4:id-41db80fc", picked.key);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[3] 本机实测形态：1 个 agent、10 条会话、当前是入口 token 派生的裸 key");
{
  const sessions = [
    row("agent:main:bw-mdavatar-y", { updatedAt: 1_789_120_457_363 }),
    row("agent:main:bw-mdavatar-x", { updatedAt: 1_789_120_457_362 }),
    row("agent:main:avatar-fix", { updatedAt: 1_789_120_457_361 }),
    row("agent:main:main", { updatedAt: 1_789_100_000_000 }),
    row("agent:main:bw-bridge", { updatedAt: 1_789_120_457_359 }),
  ];
  const out = buildSidebarSessionRows({
    agents: [{ id: "main" }],
    sessions,
    // 入口 token 派生出来的空会话，网关里并不存在
    currentSessionKey: "id-225a9df9",
  });
  ok(
    "只 1 行",
    out.length === 1,
    out.map((r) => r.key),
  );
  ok("取规范 main，而不是裸 id-225a9df9", out[0]?.key === "agent:main:main", out[0]?.key);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[4] 当前会话未落库 + 该 agent 一条会话都没有 → 显示当前会话本身");
{
  const out = buildSidebarSessionRows({
    agents: [{ id: "main" }],
    sessions: [],
    currentSessionKey: "id-deadbeef",
  });
  // 刻意选「当前会话」而不是合成的 agent:main:main：用户的消息就是发往这个 key，
  // 显示它才与「消息去哪儿」一致，且该行会正确高亮。
  ok(
    "1 行且为当前会话",
    out.length === 1 && out[0]?.key === "id-deadbeef",
    out.map((r) => r.key),
  );
}

console.log("\n[4b] 同 agent 下有别的会话、当前会话未落库 → 不让空会话挡路");
{
  const picked = pickRepresentativeSession({
    agentId: "main",
    sessions: [row("agent:main:bw-bridge", { updatedAt: 5 })],
    currentSessionKey: "id-deadbeef",
  });
  ok("rule = most-recent（不占用 current-fallback）", picked.rule === "most-recent", picked);
  ok("key = 既有会话", picked.key === "agent:main:bw-bridge", picked.key);
}

console.log("\n[4c] 当前会话是裸 key、网关里存的是规范形态 → 仍识别为同一条");
{
  const sessions = [
    row("agent:main:id-225a9df9", { updatedAt: 9 }),
    row("agent:main:main", { updatedAt: 1 }),
  ];
  const picked = pickRepresentativeSession({
    agentId: "main",
    sessions,
    currentSessionKey: "id-225a9df9",
  });
  ok("rule = current（没被 canonical-main 顶掉）", picked.rule === "current", picked);
  ok("key = 规范形态", picked.key === "agent:main:id-225a9df9", picked.key);

  const out = buildSidebarSessionRows({
    agents: [{ id: "main" }],
    sessions,
    currentSessionKey: "id-225a9df9",
  });
  ok(
    "仍然只 1 行",
    out.length === 1,
    out.map((r) => r.key),
  );
  ok(
    "sessionKeysMatch 判定为当前会话（供高亮）",
    sessionKeysMatch(out[0]?.key, "id-225a9df9", "main"),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[5] 后端返回重复 agent → 去重（每 agent 仍只有一行）");
{
  const out = buildSidebarSessionRows({
    agents: [{ id: "cet4" }, { id: "cet4" }, { id: "CET4" }],
    sessions: [row("agent:cet4:main")],
    currentSessionKey: null,
  });
  ok(
    "1 行",
    out.length === 1,
    out.map((r) => r.key),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[6] 不展示：归档 / cron / subagent / global / unknown / 派生子会话");
{
  const sessions = [
    row("agent:main:archived-x", { archived: true }),
    row("agent:main:cron:job1"),
    row("agent:main:subagent:abc"),
    row("agent:main:global-x", { kind: "global" }),
    row("agent:main:unknown-x", { kind: "unknown" }),
    row("agent:main:spawned-x", { spawnedBy: "agent:main:main" }),
    row("agent:main:main"),
  ];
  const eligible = eligibleSessionsForAgent(sessions, "main");
  ok(
    "只剩 1 条合法会话",
    eligible.length === 1,
    eligible.map((r) => r.key),
  );
  ok("是规范 main", eligible[0]?.key === "agent:main:main", eligible[0]?.key);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[7] 归属隔离：cet4 拿不到 main 的会话；agents 为空时兜底当前会话");
{
  const picked = pickRepresentativeSession({
    agentId: "cet4",
    sessions: [row("agent:main:main")],
    currentSessionKey: null,
  });
  ok("cet4 取不到 main 的会话", picked.key === "agent:cet4:main" && !picked.exists, picked);

  const out = buildSidebarSessionRows({
    agents: [],
    sessions: [row("agent:main:main")],
    currentSessionKey: "agent:main:main",
  });
  ok(
    "agents 为空时仍显示当前会话",
    out.length === 1 && out[0]?.key === "agent:main:main",
    out.map((r) => r.key),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[8] 排序：置顶优先，其次 updatedAt 倒序");
{
  const out = buildSidebarSessionRows({
    agents: [{ id: "a" }, { id: "b" }, { id: "c" }],
    sessions: [
      row("agent:a:main", { updatedAt: 100 }),
      row("agent:b:main", { updatedAt: 300 }),
      row("agent:c:main", { updatedAt: 200, pinned: true }),
    ],
    currentSessionKey: null,
  });
  ok(
    "顺序 = c(pinned), b, a",
    out.map((r) => r.key).join(",") === "agent:c:main,agent:b:main,agent:a:main",
    out.map((r) => r.key),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n[9] qualifySessionKey：裸 key 补全成规范形态");
{
  ok("裸 main → agent:main:main", qualifySessionKey("main", "main") === "agent:main:main");
  ok("裸 id-x → agent:main:id-x", qualifySessionKey("id-x", "main") === "agent:main:id-x");
  ok(
    "已规范 → 原样（仅小写）",
    qualifySessionKey("agent:CET4:Main", "main") === "agent:cet4:main",
    qualifySessionKey("agent:CET4:Main", "main"),
  );
  ok("空 → 空", qualifySessionKey("", "main") === "" && qualifySessionKey(null) === "");
  ok("不同 key 不等价", !sessionKeysMatch("agent:main:a", "agent:main:b", "main"));
}

// ───────────────────────────────────────────────────────────────────────────
// 首屏（`agents.list` / `sessions.list` 还没回来）不能把**合成行**当成完整菜单。
// 真实症状：进页面时侧栏只剩一行 —— 头像图标 + 裸 `id-<hash8>` 名字，RPC 回来后突然铺开/改名。
//
// ⚠️ 必须走 `buildSidebarSessionRows` 来测，不能只测 `pickRepresentativeSession`：
// 合成行有**三个出口**（规则④「当前会话未落库」、规则⑤「规范主会话 key」、外层「当前会话兜底」）。
// 最初只堵了最外层那个 —— 代码看起来「已经修了」，首屏却仍由规则④拼出一行裸哈希。
// 本机 CDP 逐帧实测：`t=184ms` 时 `sessions=[]`、`firstSettled=false`，
// 侧栏却是 `rows=1  titles=["id-225a9df9 · id-225a9df9"]`。
console.log("\n[8] 首屏：allowSyntheticRows 控制「合成单行」");
{
  const agents = [
    { id: "learning-consultant" },
    { id: "cet4" },
    { id: "study-abroad-consultant" },
    { id: "thesis-writing-mentor" },
  ];
  const sessions = [
    row("agent:cet4:main", { updatedAt: 3000 }),
    row("agent:study-abroad-consultant:main", { updatedAt: 2500 }),
    row("agent:thesis-writing-mentor:main", { updatedAt: 2000 }),
    row("agent:learning-consultant:main", { updatedAt: 1000 }),
  ];
  const base = { mainKey: "main", defaultAgentId: "learning-consultant" };

  // 数据齐了：4 个 agent 各一行
  const settled = buildSidebarSessionRows({
    agents,
    sessions,
    currentSessionKey: "agent:learning-consultant:main",
    ...base,
  });
  ok(
    "已经加载完：每 agent 一行（4 行）",
    settled.length === 4,
    settled.map((r) => r.key),
  );

  // 首屏 + 允许合成 → 只剩当前会话一行（旧行为，即用户报的现象）
  const initSynthetic = buildSidebarSessionRows({
    agents: [],
    sessions: [],
    currentSessionKey: "agent:learning-consultant:main",
    allowSyntheticRows: true,
    ...base,
  });
  ok(
    "首屏 + allowSyntheticRows:true → 只剩当前会话一行（旧行为）",
    initSynthetic.length === 1 && initSynthetic[0]!.key === "agent:learning-consultant:main",
    initSynthetic.map((r) => r.key),
  );

  // 首屏 + 禁止合成 → 空数组，交给骨架屏
  const initPlain = buildSidebarSessionRows({
    agents: [],
    sessions: [],
    currentSessionKey: "agent:learning-consultant:main",
    allowSyntheticRows: false,
    ...base,
  });
  ok(
    "首屏 + allowSyntheticRows:false → 空数组（渲染骨架屏）",
    initPlain.length === 0,
    initPlain.length,
  );

  // ⚠️ 本次 bug 的回归断言：agents 已就绪（例：来自本地快照）但 sessions 还没到。
  // 旧实现会由规则④ / 规则⑤ 给每个 agent 合成一行 —— 假行先于真实数据出现。
  const agentsReadySessionsEmpty = buildSidebarSessionRows({
    agents,
    sessions: [],
    currentSessionKey: "agent:learning-consultant:main",
    allowSyntheticRows: false,
    ...base,
  });
  ok(
    "agents 已就绪但 sessions 未到 + 禁止合成 → 0 行（等真实数据，不画假行）",
    agentsReadySessionsEmpty.length === 0,
    agentsReadySessionsEmpty.map((r) => r.key),
  );

  // 本机 CDP 实测形态：只有 1 个 agent、sessions 未到、当前会话是入口派生的裸 `id-<hash8>`
  const bareHashInit = buildSidebarSessionRows({
    agents: [{ id: "main" }],
    sessions: [],
    currentSessionKey: "id-225a9df9",
    allowSyntheticRows: false,
    ...base,
  });
  ok(
    "本机形态：裸 id-225a9df9 + sessions 未到 + 禁止合成 → 0 行（不再「只有当前选中」）",
    bareHashInit.length === 0,
    bareHashInit.map((r) => r.key),
  );

  // 禁止合成**不能**影响真实行
  const realDataStillWorks = buildSidebarSessionRows({
    agents: [{ id: "main" }],
    sessions: [row("agent:main:main", { updatedAt: 1000 })],
    currentSessionKey: "id-225a9df9",
    allowSyntheticRows: false,
    ...base,
  });
  ok(
    "禁止合成不影响真实行：agent:main:main 照常出",
    realDataStillWorks.length === 1 && realDataStillWorks[0]!.key === "agent:main:main",
    realDataStillWorks.map((r) => r.key),
  );

  // 落定后 sessions.list 失败（sessions 仍为空）→ 允许合成，保住当前会话可见性
  const degraded = buildSidebarSessionRows({
    agents: [],
    sessions: [],
    currentSessionKey: "agent:learning-consultant:main",
    allowSyntheticRows: true,
    ...base,
  });
  ok(
    "网关降级（sessions 拉不到）+ 允许合成 → 当前会话兜底保留",
    degraded.length === 1,
    degraded.length,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 合成行的另外两个出口就在 `pickRepresentativeSession` 里（规则④⑤）。
// 首屏必须由**同一个开关**关掉，否则 `buildSidebarSessionRows` 外层的拦截形同虚设。
console.log("\n[10] pickRepresentativeSession：合成行出口（规则④⑤）");
{
  const common = { mainKey: "main", defaultAgentId: "main" };

  const allowed = pickRepresentativeSession({
    agentId: "main",
    sessions: [],
    currentSessionKey: "id-225a9df9",
    ...common,
  });
  ok(
    "空 sessions + 允许合成 + 归属当前 agent → 规则④ current-fallback（裸 key）",
    allowed.rule === "current-fallback" && allowed.key === "id-225a9df9",
    allowed,
  );

  const banned = pickRepresentativeSession({
    agentId: "main",
    sessions: [],
    currentSessionKey: "id-225a9df9",
    allowSyntheticRows: false,
    ...common,
  });
  ok(
    "空 sessions + 禁止合成 → rule=none / key 为空（调用方 continue，不画行）",
    banned.rule === "none" && banned.key === "" && banned.exists === false,
    banned,
  );

  const allowedNoCurrent = pickRepresentativeSession({
    agentId: "cet4",
    sessions: [],
    ...common,
  });
  ok(
    "无当前会话 + 空 sessions + 允许合成 → 规则⑤ 合成 agent:cet4:main",
    allowedNoCurrent.rule === "canonical-main-fallback" &&
      allowedNoCurrent.key === "agent:cet4:main",
    allowedNoCurrent,
  );

  const bannedNoCurrent = pickRepresentativeSession({
    agentId: "cet4",
    sessions: [],
    allowSyntheticRows: false,
    ...common,
  });
  ok(
    "无当前会话 + 空 sessions + 禁止合成 → 规则⑤ 同样被关掉",
    bannedNoCurrent.rule === "none" && bannedNoCurrent.key === "",
    bannedNoCurrent,
  );

  const realWins = pickRepresentativeSession({
    agentId: "main",
    sessions: [row("agent:main:main", { updatedAt: 9 })],
    currentSessionKey: "id-225a9df9",
    allowSyntheticRows: false,
    ...common,
  });
  ok(
    "有真实主会话时，禁止合成不影响选择（仍是 canonical-main / exists:true）",
    realWins.rule === "canonical-main" &&
      realWins.key === "agent:main:main" &&
      realWins.exists === true,
    realWins,
  );

  const currentExists = pickRepresentativeSession({
    agentId: "main",
    sessions: [row("agent:main:id-225a9df9", { updatedAt: 9 })],
    currentSessionKey: "id-225a9df9",
    allowSyntheticRows: false,
    ...common,
  });
  ok(
    "当前会话真实存在时，禁止合成也照常命中规则①",
    currentExists.rule === "current" && currentExists.exists === true,
    currentExists,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// [11] 事件隔离：网关广播帧能不能被认成「当前会话」。
//
// 真实事故（本机 CDP 实测）：入口 `#token=` 派生的会话 key 是裸 `id-225a9df9`，
// 而网关下发的事件里 `sessionKey` 一律是规范形态 `agent:main:id-225a9df9`。
// `handleEvent` 当时用 `areUiSessionKeysEquivalent` 比较 —— 它只把裸 `main` 补成
// `agent:main:main`，**补不出 agent 前缀** → 恒为 false → 所有 `chat` / `agent`
// 事件（含 `state:"error"`）全被当成「别的会话」丢弃 → `sending` 永远 true →
// UI 永久卡在三点「思考中」，正文 / 思考 / 错误全都不显示。
//
// 这条断言锁住：裸 key ↔ 规范 key 必须判为同一会话。
console.log("\n[11] 事件隔离：裸 key ↔ 规范 key 必须判为同一会话");
{
  ok(
    "裸 id-<hash8> ↔ agent:main:id-<hash8> → 同一会话（事故用例）",
    sessionKeysMatch("id-225a9df9", "agent:main:id-225a9df9", "main") === true,
  );
  ok("反向也成立", sessionKeysMatch("agent:main:id-225a9df9", "id-225a9df9", "main") === true);
  ok("裸 main ↔ agent:main:main → 同一会话", sessionKeysMatch("main", "agent:main:main", "main"));
  ok("大小写不敏感", sessionKeysMatch("ID-225A9DF9", "agent:MAIN:id-225a9df9", "main"));
  ok(
    "别的 agent 的同名裸 key 不算同一会话",
    !sessionKeysMatch("id-225a9df9", "agent:cet4:id-225a9df9", "main"),
  );
  ok("不同会话仍不等价", !sessionKeysMatch("agent:main:a", "agent:main:b", "main"));
  ok(
    "空值不比出「同一会话」（避免放行一切）",
    !sessionKeysMatch("", "agent:main:main", "main") &&
      !sessionKeysMatch("agent:main:main", null, "main"),
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
