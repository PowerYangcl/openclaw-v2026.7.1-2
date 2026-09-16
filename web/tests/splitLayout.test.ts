/**
 * 单元测试：拆分视图布局模型（`src/utils/splitLayout.ts`）。
 *
 * 为什么要有：布局是「列 × 窗格 + 两组相对权重」的嵌套结构，插入/关闭窗格后
 * **必须重新归一化**，否则某一层会整体缩水（表现为「新开的窗格只有一条缝」）。
 * 这类错误在屏幕上很难一眼看出，而且只有在特定顺序（先下拆再右拆、关中间那个）
 * 才暴露 —— 正是单测该锁住的东西。
 *
 * 另外锁住两条与「渲染层」的契约：
 *   1. `closePane` 只剩一个窗格时返回 `undefined`（布局层据此退回单窗格）；
 *   2. `normalizeChatSplitLayout` 对脏数据（权重全 0 / id 重复 / 空 sessionKey /
 *      只有一个窗格）必须**静默拒绝**，否则读到脏盘会渲染出宽度 0 的列。
 *
 * 运行：`npm run test:unit`（或 `npm run test:unit:split`）
 */
import {
  closePane,
  createSinglePaneLayout,
  createSplitLayout,
  findPane,
  insertPane,
  normalizeChatSplitLayout,
  nextPaneId,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  type ChatSplitLayout,
} from "@/utils/splitLayout";

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

const shape = (l: ChatSplitLayout | undefined) =>
  l
    ? l.columns
        .map(
          (c) =>
            `[${c.panes.map((p) => p.id).join("|")}]=${c.paneWeights.map((w) => w.toFixed(3)).join(",")}`,
        )
        .join(" ") +
      ` cols=${l.columnWeights.map((w) => w.toFixed(3)).join(",")} active=${l.activePaneId}`
    : "undefined";

console.log("\n[1] 单窗格 / 打开拆分视图");
{
  const single = createSinglePaneLayout("s1");
  ok(
    "单窗格：1 列 1 窗格、权重 1、active=p1",
    single.columns.length === 1 &&
      single.columns[0].panes.length === 1 &&
      single.columnWeights[0] === 1 &&
      single.activePaneId === "p1",
    shape(single),
  );

  const split = createSplitLayout("s1");
  ok("打开拆分：2 列各 1 窗格（左右并排）", split.columns.length === 2, shape(split));
  ok(
    "两列权重各 0.5（均匀裂开）",
    split.columnWeights.join(",") === "0.5,0.5",
    split.columnWeights,
  );
  ok("新窗格 p2 持有同一个会话", findPane(split, "p2")?.pane.sessionKey === "s1");
  ok("新窗格成为活动窗格（对齐旧版 insertPane）", split.activePaneId === "p2", split.activePaneId);
}

console.log("\n[2] insertPane：四个方向 + 权重重新分配");
{
  const base = createSplitLayout("s1");
  const right = insertPane(base, "p1", "s2", "right");
  ok(
    "向右插入 → 3 列，且被拆那一列一分为二",
    right.columns.length === 3 &&
      right.columnWeights.map((w) => w.toFixed(3)).join(",") === "0.250,0.250,0.500",
    shape(right),
  );
  ok(
    "新列插在目标列的**右侧**（顺序 p1|s2|p2）",
    right.columns.map((c) => c.panes[0].id).join(",") === "p1,p3,p2",
    right.columns.map((c) => c.panes[0].id),
  );

  const left = insertPane(base, "p1", "s2", "left");
  ok(
    "向左插入 → 新列排在目标列之前",
    left.columns.map((c) => c.panes[0].id).join(",") === "p3,p1,p2",
    left.columns.map((c) => c.panes[0].id),
  );

  const down = insertPane(base, "p1", "s2", "down");
  ok(
    "向下插入 → 列数不变、第一列变 2 个窗格",
    down.columns.length === 2 &&
      down.columns[0].panes.length === 2 &&
      down.columns[0].paneWeights.join(",") === "0.5,0.5",
    shape(down),
  );
  ok("向下插入后 active = 新窗格", down.activePaneId === "p3", down.activePaneId);
  ok(
    "纵向权重归一化后合计 1",
    down.columns[0].paneWeights.reduce((a, b) => a + b, 0).toFixed(6) === "1.000000",
  );

  const up = insertPane(base, "p1", "s2", "up");
  ok(
    "向上插入 → 新窗格排在目标窗格之前",
    up.columns[0].panes.map((p) => p.id).join(",") === "p3,p1",
    up.columns[0].panes.map((p) => p.id),
  );

  ok(
    "对不存在的窗格插入 = 原样返回",
    JSON.stringify(insertPane(base, "nope", "s9", "right")) === JSON.stringify(base),
  );
}

console.log("\n[3] closePane：关中间 / 关最后一个 → undefined");
{
  // 3 列：p1(0.25) | p3(0.25,由 p1 右拆) | p2(0.5)
  const three = insertPane(createSplitLayout("s1"), "p1", "s2", "right");
  const closed = closePane(three, "p3");
  // ⚠️ 归一化是**保留相对比例**（0.25 : 0.5 = 1 : 2），不是「剩下的均分」。
  // 写成 0.5/0.5 就断了「p2 一开始更宽」这件事，用户会觉得拖动被重置了。
  ok(
    "关中间一列 → 剩 2 列、权重按原比例重新归一",
    !!closed &&
      closed.columns.length === 2 &&
      closed.columnWeights.map((w) => w.toFixed(3)).join(",") === "0.333,0.667",
    shape(closed),
  );
  ok(
    "重新归一后两列仍是 1 : 2（相对比例没被抹平）",
    !!closed && Math.abs(closed.columnWeights[1] / closed.columnWeights[0] - 2) < 1e-9,
    closed?.columnWeights,
  );
  ok(
    "重新归一后列权重合计为 1",
    !!closed && Math.abs(closed.columnWeights.reduce((a, b) => a + b, 0) - 1) < 1e-9,
    closed?.columnWeights,
  );
  ok("关掉的是活动窗格 → active 落到相邻窗格", closed?.activePaneId === "p1", closed?.activePaneId);

  const two = closePane(three, "p1");
  ok("关到只剩 2 个 → 仍是有效布局", !!two && panesOf(two).length === 2, shape(two));
  const one = two ? closePane(two, two.columns[0].panes[0].id) : undefined;
  ok("关到只剩 1 个 → 返回 undefined（布局层据此退回单窗格）", one === undefined, shape(one));

  // 同列下拆后关掉一个
  const stacked = insertPane(createSplitLayout("s1"), "p1", "s2", "down");
  const afterClose = closePane(stacked, "p3");
  ok(
    "同列 2 窗格关掉 1 个 → 该列回到 1 窗格、权重 1",
    !!afterClose &&
      afterClose.columns[0].panes.length === 1 &&
      afterClose.columns[0].paneWeights.join(",") === "1",
    shape(afterClose),
  );

  ok(
    "关不存在的窗格 = 原样返回（含 active）",
    (() => {
      const r = closePane(three, "nope");
      return !!r && r.activePaneId === three.activePaneId && shape(r) === shape(three);
    })(),
  );
}

console.log("\n[4] 会话切换 / 活动窗格");
{
  const base = createSplitLayout("s1");
  const next = setPaneSession(base, "p2", "agent:main:abc");
  ok(
    "setPaneSession 只改目标窗格",
    findPane(next, "p2")?.pane.sessionKey === "agent:main:abc" &&
      findPane(next, "p1")?.pane.sessionKey === "s1",
    panesOf(next).map((p) => `${p.id}=${p.sessionKey}`),
  );
  ok("setPaneSession 不改变原布局（纯函数）", findPane(base, "p2")?.pane.sessionKey === "s1");

  ok("setActivePane 接受已存在的 id", setActivePane(base, "p1").activePaneId === "p1");
  ok(
    "setActivePane 拒绝不存在的 id（保持原 active）",
    setActivePane(base, "nope").activePaneId === base.activePaneId,
  );
}

console.log("\n[5] 拖拽调比例：夹在 0.15 / 0.85 内，且只动相邻一对");
{
  const three = insertPane(createSplitLayout("s1"), "p1", "s2", "right");
  const wide = resizeColumns(three, 0, 0.9);
  ok(
    "超上限被夹到 0.85（配对总和的 85%）",
    wide.columnWeights[0] > 0.42 && wide.columnWeights[0] < 0.43,
    wide.columnWeights,
  );
  const narrow = resizeColumns(three, 0, -5);
  ok("低于下限被夹到 0.15", Math.abs(narrow.columnWeights[0] - 0.075) < 1e-9, narrow.columnWeights);
  ok("未参与拖拽的第三列权重不变", wide.columnWeights[2] === three.columnWeights[2], [
    three.columnWeights[2],
    wide.columnWeights[2],
  ]);
  ok(
    "越界 boundaryIndex 不产生 NaN",
    resizeColumns(three, 9, 0.5).columnWeights.every((w) => Number.isFinite(w)),
  );

  const stacked = insertPane(createSplitLayout("s1"), "p1", "s2", "down");
  const resized = resizePanes(stacked, stacked.columns[0].id, 0, 0.3);
  ok(
    "列内上下比例同样被夹住并归一",
    resized.columns[0].paneWeights[0] === 0.3 && resized.columns[0].paneWeights[1] === 0.7,
    resized.columns[0].paneWeights,
  );
  ok(
    "resizePanes 对未知列 id 静默返回原值",
    JSON.stringify(resizePanes(stacked, "c99", 0, 0.3)) === JSON.stringify(stacked),
  );
}

console.log("\n[6] nextPaneId / findPane");
{
  const three = insertPane(createSplitLayout("s1"), "p1", "s2", "right");
  ok("nextPaneId 取最大序号 +1", nextPaneId(three) === "p4", nextPaneId(three));
  ok(
    "findPane 返回准确的列/窗格下标",
    (() => {
      const loc = findPane(three, "p2");
      return loc?.columnIndex === 2 && loc?.paneIndex === 0;
    })(),
    findPane(three, "p2"),
  );
  ok("findPane 对不存在的 id 返回 null", findPane(three, "zzz") === null);
}

console.log("\n[7] 脏数据读盘：一律静默拒绝，绝不放行半成品");
{
  const good = createSplitLayout("s1");
  ok("合法布局可往返", !!normalizeChatSplitLayout(JSON.parse(JSON.stringify(good))));

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["字符串", "nope"],
    ["缺 columns", { columnWeights: [1] }],
    ["columns 不是数组", { columns: {} }],
    [
      "只有一个窗格（应退回单窗格）",
      {
        columns: [{ id: "c1", panes: [{ id: "p1", sessionKey: "s" }], paneWeights: [1] }],
        columnWeights: [1],
        activePaneId: "p1",
      },
    ],
    [
      "sessionKey 全是空白",
      {
        columns: [
          {
            panes: [
              { id: "p1", sessionKey: "   " },
              { id: "p2", sessionKey: "" },
            ],
          },
        ],
        columnWeights: [1],
        activePaneId: "p1",
      },
    ],
  ];
  for (const [label, value] of bad) {
    ok(`${label} → undefined（退回单窗格）`, normalizeChatSplitLayout(value) === undefined);
  }

  const weightsPoisoned = normalizeChatSplitLayout({
    columns: [
      { id: "c1", panes: [{ id: "p1", sessionKey: "a" }], paneWeights: [0] },
      { id: "c2", panes: [{ id: "p2", sessionKey: "b" }], paneWeights: [0] },
    ],
    columnWeights: [0, 0],
    activePaneId: "p9",
  });
  ok(
    "权重全 0 → 归一为均分（不产生 NaN / 0 宽列）",
    !!weightsPoisoned &&
      weightsPoisoned.columnWeights.join(",") === "0.5,0.5" &&
      weightsPoisoned.columns.every((c) => c.paneWeights.every((w) => Number.isFinite(w) && w > 0)),
    shape(weightsPoisoned),
  );
  ok(
    "非法 activePaneId → 落到第一个窗格",
    weightsPoisoned?.activePaneId === "p1",
    weightsPoisoned?.activePaneId,
  );

  const dupIds = normalizeChatSplitLayout({
    columns: [
      { id: "c1", panes: [{ id: "p1", sessionKey: "a" }], paneWeights: [1] },
      {
        id: "c1",
        panes: [
          { id: "p1", sessionKey: "b" },
          { id: "p2", sessionKey: "c" },
        ],
        paneWeights: [1, 1],
      },
    ],
    columnWeights: [1, 1],
    activePaneId: "p1",
  });
  ok(
    "重复 id 被重排（列 / 窗格 id 都唯一）",
    !!dupIds &&
      new Set(dupIds.columns.map((c) => c.id)).size === dupIds.columns.length &&
      new Set(panesOf(dupIds).map((p) => p.id)).size === panesOf(dupIds).length,
    shape(dupIds),
  );
  ok(
    "重复 id 时窗格权重数量与窗格数一致（不会错位）",
    !!dupIds && dupIds.columns.every((c) => c.paneWeights.length === c.panes.length),
    dupIds?.columns.map((c) => `${c.panes.length}/${c.paneWeights.length}`),
  );

  const partial = normalizeChatSplitLayout({
    columns: [
      {
        id: "c1",
        panes: [{ id: "p1", sessionKey: "a" }, { sessionKey: "  " }],
        paneWeights: [0.7, 0.3],
      },
      { id: "c2", panes: [{ id: "p2", sessionKey: "b" }], paneWeights: [1] },
    ],
    columnWeights: [0.7, 0.3],
    activePaneId: "p2",
  });
  ok(
    "丢掉非法窗格后，剩下的权重按存活项重新归一",
    !!partial &&
      partial.columns[0].paneWeights.length === 1 &&
      partial.columns[0].paneWeights[0] === 1,
    shape(partial),
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
