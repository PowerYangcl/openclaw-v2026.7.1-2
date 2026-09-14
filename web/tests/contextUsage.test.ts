/**
 * 单元测试：上下文占用计算（`src/utils/contextUsage.ts`）。
 *
 * 为什么要有：这个口径**从 UI 上很难看出对错**，而且我们踩过一次 ——
 * 曾把「已用」写成 `input + cacheRead + cacheWrite + output`（含 output），
 * 结果「已用」数值与旧版 UI 对不上。
 *
 * 本文件第 [0] 组用**旧版界面的真实截图数据**做反推验算，锁死口径：
 *   窗口 1,048,576 · input 917 · cacheRead 26,624 · cacheWrite 0 · output 92
 *   → 已用 27,541 / 剩余 1,021,035 / 占用 3%
 *
 * 运行：`npm run test:unit`
 */
import {
  contextPercentClassOf,
  contextPercentOf,
  contextRemainingTokensOf,
  contextUsedTokensOf,
  normalizeContextWindow,
} from "@/utils/contextUsage";

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

/** 旧版界面截图里的那条真实记录（GLM-5.1 / 1M 窗口）。 */
const SHOT = {
  usage: { input: 917, cacheRead: 26_624, cacheWrite: 0, output: 92, totalTokens: 27_633 },
  window: 1_048_576,
};

console.log("\n[0] 反推验算：复现旧版界面截图上的三个数字");
{
  ok(
    "已用 = 917 + 26,624 + 0 = 27,541（不含 output 92）",
    contextUsedTokensOf(SHOT.usage) === 27_541,
    contextUsedTokensOf(SHOT.usage),
  );
  ok(
    "剩余 = 1,048,576 − 27,541 = 1,021,035",
    contextRemainingTokensOf(SHOT.usage, SHOT.window) === 1_021_035,
    contextRemainingTokensOf(SHOT.usage, SHOT.window),
  );
  ok(
    "占用 = round(27,541 / 1,048,576 × 100) = 3%",
    contextPercentOf(SHOT.usage, SHOT.window) === 3,
    contextPercentOf(SHOT.usage, SHOT.window),
  );
  ok(
    "已用 + 剩余 恒等于窗口",
    contextUsedTokensOf(SHOT.usage) + contextRemainingTokensOf(SHOT.usage, SHOT.window) ===
      SHOT.window,
  );
}

console.log("\n[1] contextUsedTokensOf：三个字段求和（刻意不含 output）");
{
  ok(
    "input + cacheRead + cacheWrite 全算",
    contextUsedTokensOf({ input: 1000, output: 300, cacheRead: 5000, cacheWrite: 200 }) === 6200,
    contextUsedTokensOf({ input: 1000, output: 300, cacheRead: 5000, cacheWrite: 200 }),
  );
  ok(
    "**只有 output 时算 0**（回归护栏：含 output 的口径会让这里变成 42）",
    contextUsedTokensOf({ input: 0, output: 42, cacheRead: 0, cacheWrite: 0 }) === 0,
    contextUsedTokensOf({ input: 0, output: 42, cacheRead: 0, cacheWrite: 0 }),
  );
  ok(
    "三字段全 0 → 退回 totalTokens",
    contextUsedTokensOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7777 }) ===
      7777,
  );
  ok(
    "三字段有值时不看 totalTokens（避免口径漂移）",
    contextUsedTokensOf({
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 99999,
    }) === 10,
  );
  ok(
    "undefined / null → 0",
    contextUsedTokensOf(undefined) === 0 && contextUsedTokensOf(null) === 0,
  );
}

console.log("\n[2] contextRemainingTokensOf：剩余不为负");
{
  ok(
    "正常相减",
    contextRemainingTokensOf({ input: 30, output: 0, cacheRead: 70, cacheWrite: 0 }, 200) === 100,
  );
  ok(
    "超出窗口 → 夹到 0（不显示负数）",
    contextRemainingTokensOf({ input: 500, output: 0, cacheRead: 0, cacheWrite: 0 }, 200) === 0,
  );
  ok(
    "无窗口 → 0",
    contextRemainingTokensOf({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, null) === 0,
  );
  ok(
    "无用量 → 整个窗口都剩",
    contextRemainingTokensOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 1000) === 1000,
  );
}

console.log("\n[3] contextPercentOf：动态百分比");
{
  ok(
    "100000 / 200000 → 50%",
    contextPercentOf({ input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 200_000) === 50,
  );
  ok(
    "超过窗口 → 截断到 100%",
    contextPercentOf({ input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 200_000) === 100,
  );
  ok(
    "恰好 90%",
    contextPercentOf({ input: 180_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 200_000) === 90,
  );
  ok(
    "极小占用 → 0%（有数据就是 0，不是 null）",
    contextPercentOf({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, 200_000) === 0,
  );
  ok(
    "无用量 → null（UI 显示「— ctx」而不是假的 0%）",
    contextPercentOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 200_000) === null,
  );
  ok(
    "无窗口 → null",
    contextPercentOf({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, null) === null,
  );
}

console.log("\n[4] normalizeContextWindow：非法窗口一律视作未知");
{
  ok("正数原样", normalizeContextWindow(200_000) === 200_000);
  ok(
    "0 / 负数 / NaN / null / undefined → 0",
    normalizeContextWindow(0) === 0 &&
      normalizeContextWindow(-1) === 0 &&
      normalizeContextWindow(Number.NaN) === 0 &&
      normalizeContextWindow(null) === 0 &&
      normalizeContextWindow(undefined) === 0,
  );
  ok("Infinity → 0", normalizeContextWindow(Number.POSITIVE_INFINITY) === 0);
}

console.log("\n[5] contextPercentClassOf：配色阈值");
{
  ok("null → 无类（不涂色）", contextPercentClassOf(null) === "");
  ok("50% → 无类", contextPercentClassOf(50) === "");
  ok("74% → 无类", contextPercentClassOf(74) === "");
  ok("75% → ctx-warn", contextPercentClassOf(75) === "ctx-warn");
  ok("89% → ctx-warn", contextPercentClassOf(89) === "ctx-warn");
  ok("90% → ctx-danger", contextPercentClassOf(90) === "ctx-danger");
  ok("100% → ctx-danger", contextPercentClassOf(100) === "ctx-danger");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
