/**
 * `utils/chatRunState` 单测 —— 守住「点拆分视图不打断进行中的任务」这条底线。
 *
 * 背景：`ChatView` 在单窗格 ↔ 拆分之间切换时会**销毁并重建** `ChatPane`
 * （`v-if="!layout"` 换成 `.chat-split-view` 子树，`paneId` 也变）。
 * 运行态原本是 ChatPane 的局部 ref ⇒ 一拆就没了，看起来像任务被打断
 * （实测：拆分前 liveThinking=1，拆分后 liveThinking=0）。
 * 现在状态按会话存在组件外，本文件钉住这个语义。
 */
import { chatRunStateFor, chatRunStateSize, resetChatRunState } from "@/utils/chatRunState";
import { qualifySessionKey } from "@/utils/sessionListSelection";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, { actual, expected });
}

console.log("[1] 同一个会话 = 同一个桶");
{
  const a = chatRunStateFor("id-abc123", "main");
  const b = chatRunStateFor("agent:main:id-abc123", "main");
  check("裸 key 与带 agent 前缀的规范 key 命中同一个桶（与事件隔离判定同源）", a === b);
  check(
    "qualifySessionKey 确实把两者归一（前置条件自检）",
    qualifySessionKey("id-abc123", "main") === qualifySessionKey("agent:main:id-abc123", "main"),
    {
      bare: qualifySessionKey("id-abc123", "main"),
      qualified: qualifySessionKey("agent:main:id-abc123", "main"),
    },
  );
  const c = chatRunStateFor("ID-ABC123", "main");
  check("大小写不同仍算同一会话", a === c);
}

console.log("[2] 不同会话 = 不同桶");
{
  const x = chatRunStateFor("id-aaa", "main");
  const y = chatRunStateFor("id-bbb", "main");
  check("不同 mainKey 不同桶", x !== y);
  const z = chatRunStateFor("id-aaa", "cet4");
  check("同一 mainKey 但不同 agent 也不同桶", x !== z, {
    main: qualifySessionKey("id-aaa", "main"),
    cet4: qualifySessionKey("id-aaa", "cet4"),
  });
}

console.log("[3] 字段可读写（reactive）");
{
  const s = chatRunStateFor("id-rw", "main");
  s.sending = true;
  s.streamingText = "半句";
  s.streamingThinking = "在想";
  s.streamingSpend = { spend: 3, balance: 97 };
  s.steerCount = 2;
  eq("sending", s.sending, true);
  eq("streamingText", s.streamingText, "半句");
  eq("streamingThinking", s.streamingThinking, "在想");
  eq("streamingSpend.spend", s.streamingSpend?.spend, 3);
  eq("steerCount", s.steerCount, 2);
  // 另一个「窗格」取同一个桶，应当立刻看到同一份内容
  const same = chatRunStateFor("id-rw", "main");
  eq("另一个窗格读到同一份 sending", same.sending, true);
  eq("另一个窗格读到同一份正文", same.streamingText, "半句");
}

console.log("[4] 空 / 缺省 key 的兜底");
{
  const a = chatRunStateFor("", "main");
  const b = chatRunStateFor(undefined, "main");
  check("空串与 undefined 都落到同一个兜底桶", a === b);
  check("兜底桶可用", typeof a.sending === "boolean");
}

console.log("[5] resetChatRunState：只清字段，不换对象");
{
  const s = chatRunStateFor("id-reset", "main");
  s.sending = true;
  s.streamingText = "很长的一段流式正文".repeat(50);
  s.streamingSpend = { spend: 1, balance: 9 };
  s.steerCount = 4;
  const before = chatRunStateFor("id-reset", "main");
  resetChatRunState(s);
  eq("sending 归位", s.sending, false);
  eq("streamingText 清空（释放长文本）", s.streamingText, "");
  eq("streamingThinking 清空", s.streamingThinking, "");
  eq("streamingSpend 清空", s.streamingSpend, null);
  eq("steerCount 归位", s.steerCount, 0);
  check("清空后仍是同一个对象（别的窗格不会拿到新桶）", before === s);
  const again = chatRunStateFor("id-reset", "main");
  check("重新取也还是同一个对象", again === s);
}

console.log("[6] 桶数量只增不减（多窗格共享，不能随便删）");
{
  const n0 = chatRunStateSize();
  chatRunStateFor("id-size-1", "main");
  const n1 = chatRunStateSize();
  check("新会话会让桶 +1", n1 === n0 + 1, { n0, n1 });
  chatRunStateFor("id-size-1", "main");
  eq("重复取同一个会话不新增桶", chatRunStateSize(), n1);
  resetChatRunState(chatRunStateFor("id-size-1", "main"));
  eq("reset 之后桶依然在（不删，避免多窗格分歧）", chatRunStateSize(), n1);
}

console.log("");
console.log(`==== ${passed} passed, ${failures.length} failed ====`);
if (failures.length > 0) {
  console.log(failures.map((f) => "  - " + f).join("\n"));
  process.exitCode = 1;
}
