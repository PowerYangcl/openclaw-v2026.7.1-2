/**
 * JD spend 轮询口径测试。
 *
 * 核心不变式：`balance` 只能是上游 `key.balance` 的**原值**，网关不得做
 * 任何加减推算。确认不了「本轮消费已入账」时回退到最近一次观测到的原值
 * （可能偏大，但绝不偏小 —— 偏小就是「多扣」），再交前端 `chat.spend.getBatch`
 * 在 4s 后用终值校正。
 *
 * 背景：旧实现用 `firstBalance - spend` 兜底，而上游经常在 final 帧之前
 * 就已入账，于是本轮花费被扣第二次。用户看到的「后面的消息剩余积分反而
 * 变多」（4911.87 → 4912.65）就是错值（真值 − spend）与真值混排的结果。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提升到 import 之前，工厂里只能引用 vi.hoisted 提升出来的状态。
const harness = vi.hoisted(() => ({ apiKey: "key-default" }));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    models: {
      providers: {
        "jd-llm": { apiKey: harness.apiKey, spendBaseUrl: "https://spend.invalid" },
      },
    },
  }),
}));

const { pollJdSpendForChat } = await import("./openresponses-http.js");

/** 上游一次响应：金额用**原始单位**（与线上一致），函数内部再 ×1000 展示。 */
type RawRecord = { spend?: number; key?: { spend?: number; balance?: number } };

function stubUpstreamSequence(records: RawRecord[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const record = records[Math.min(i, records.length - 1)] ?? {};
    i += 1;
    return new Response(JSON.stringify(record), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const FAST = { retryDelayMs: 1, deadlineMs: 60 } as const;

beforeEach(() => {
  harness.apiKey = `key-${Math.random().toString(36).slice(2, 10)}`;
  vi.unstubAllGlobals();
});

describe("pollJdSpendForChat：只用上游原值", () => {
  it("首探就已入账 ⇒ 原样返回上游余额，不重复扣 spend", async () => {
    // 基线：上一轮确认到 key.spend=1.0 / balance=4912.65
    stubUpstreamSequence([{ spend: 0.0001, key: { spend: 1.0, balance: 4.91265 } }]);
    await pollJdSpendForChat("chatcmpl-baseline", { ...FAST, mode: "history" });

    // 本轮：上游已入账（累计值 1.00078 已含本轮 0.00078），余额 4911.87
    stubUpstreamSequence([{ spend: 0.00078, key: { spend: 1.00078, balance: 4.91187 } }]);
    const out = await pollJdSpendForChat("chatcmpl-settled", FAST);

    expect(out.spend).toBe(0.78);
    // 旧实现这里会返回 4911.87 - 0.78 = 4911.09
    expect(out.balance).toBe(4911.87);
  });

  it("首探未入账、窗口内入账 ⇒ 返回入账后的上游余额", async () => {
    stubUpstreamSequence([{ spend: 0.0001, key: { spend: 1.0, balance: 4.91265 } }]);
    await pollJdSpendForChat("chatcmpl-baseline", { ...FAST, mode: "history" });

    stubUpstreamSequence([
      { spend: 0.00078, key: { spend: 1.0, balance: 4.91265 } },
      { spend: 0.00078, key: { spend: 1.00078, balance: 4.91187 } },
    ]);
    const out = await pollJdSpendForChat("chatcmpl-late-settle", {
      retryDelayMs: 1,
      deadlineMs: 400,
    });

    expect(out).toEqual({ spend: 0.78, balance: 4911.87 });
  });

  it("窗口内始终没入账 ⇒ 回退到最近一次上游原值（有数、且不偏小）", async () => {
    stubUpstreamSequence([{ spend: 0.0001, key: { spend: 1.0, balance: 4.91265 } }]);
    await pollJdSpendForChat("chatcmpl-baseline", { ...FAST, mode: "history" });

    stubUpstreamSequence([{ spend: 0.00078, key: { spend: 1.0, balance: 4.91265 } }]);
    const out = await pollJdSpendForChat("chatcmpl-not-settled", FAST);

    expect(out.spend).toBe(0.78);
    // 未入账 ⇒ 余额还没扣本轮（偏高）。这里只能给原值：宁可偏大也不能偏小。
    expect(out.balance).toBe(4912.65);
  });

  it("无基线（冷启动）⇒ 仍给上游原值，不推算", async () => {
    stubUpstreamSequence([{ spend: 0.00078, key: { spend: 1.00078, balance: 4.91187 } }]);
    const out = await pollJdSpendForChat("chatcmpl-cold-start", FAST);

    expect(out.spend).toBe(0.78);
    expect(out.balance).toBe(4911.87);
  });

  it("spend=0 ⇒ 直接透出上游余额原值", async () => {
    stubUpstreamSequence([{ spend: 0, key: { spend: 1.0, balance: 4.91265 } }]);
    const out = await pollJdSpendForChat("chatcmpl-zero", FAST);

    expect(out).toEqual({ spend: 0, balance: 4912.65 });
  });

  it("history 模式 ⇒ 首探即返，不等待、不推算", async () => {
    const fetchMock = stubUpstreamSequence([
      { spend: 0.00078, key: { spend: 1.0, balance: 4.91265 } },
    ]);
    const out = await pollJdSpendForChat("chatcmpl-history", { ...FAST, mode: "history" });

    expect(out).toEqual({ spend: 0.78, balance: 4912.65 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上游不返回 key 对象 ⇒ balance 为 null（不再回落成 0）", async () => {
    stubUpstreamSequence([{ spend: 0.00078 }]);
    const out = await pollJdSpendForChat("chatcmpl-no-key", FAST);

    expect(out.spend).toBe(0.78);
    expect(out.balance).toBeNull();
  });

  it("累计值回退（充值重置）⇒ 作废旧基线，不用旧值比较", async () => {
    stubUpstreamSequence([{ spend: 0.0001, key: { spend: 9.0, balance: 1.0 } }]);
    await pollJdSpendForChat("chatcmpl-baseline", { ...FAST, mode: "history" });

    // 充值后累计值从 9.0 回到 0.01，余额变大 —— 属于真实变化，不能被当成异常值压掉
    stubUpstreamSequence([{ spend: 0.00078, key: { spend: 0.01, balance: 99.0 } }]);
    const out = await pollJdSpendForChat("chatcmpl-after-topup", FAST);

    expect(out.spend).toBe(0.78);
    // 基线作废后无法判定入账 ⇒ 仍然给原值（×1000 口径：99 → 99000），4s 后回填会校正
    expect(out.balance).toBe(99000);
  });
});
