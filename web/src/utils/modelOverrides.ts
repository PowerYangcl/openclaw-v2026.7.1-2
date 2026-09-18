/**
 * 模型覆盖 —— **按会话隔离**，拆分视图下每个窗格各选各的模型。
 *
 * ## 为什么需要它
 *
 * 模型的用户选择原本只存在 `settings.selectedModel`（localStorage，全局一份）。
 * 单窗格下没问题；拆分视图下就成了「窗格之间互相影响」：A 窗格把模型从
 * DeepSeek 切成 GLM，B 窗格的选择器跟着一起变。
 *
 * 对齐旧版 `ui/src/lib/sessions/index.ts` 的 `modelOverrides`：以**规范会话 key**
 * 为键存覆盖值 —— 同一会话的多个窗格共享同一份（符合直觉：同一个 run 两边看到的
 * 应当一样），不同会话互不影响。
 *
 * ## 空串有语义，不要当空值过滤掉
 *
 * 选择器里「空串 = 使用网关默认模型」是一个**显式选择**。如果落盘时把它当空值删键，
 * 读取就会回落到全局偏好里的另一个模型，用户会看到自己刚选的「默认模型」又变回
 * 具体模型名。所以这里**保留空串**，只用「键是否存在」（`undefined` vs `""`）
 * 区分「显式选过默认」和「没选过」。
 *
 * ⚠️ 这一点与项目里「持久化的空串一律删键」的约定**刻意相反**（见
 * `stores/settings.ts` 的 `SessionPatch`）；那边空串是无效输入，这边空串是合法取值。
 */
import { ref } from "vue";

const STORAGE_KEY = "openclaw.web.modelOverrides.v1";

type ModelOverrideMap = Record<string, string>;

/** localStorage 在隐私模式下会抛异常 —— 统一降级为「只在本次会话内有效」。 */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): ModelOverrideMap {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ModelOverrideMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 键必须非空；值只收字符串（含空串，见文件头说明）
      if (typeof key === "string" && key.trim() && typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 覆盖表（模块级单例，所有窗格共享同一份）。
 *
 * 写入时**整体替换对象**而不是改字段：`ref` 只跟踪对象身份，原地改字段不会
 * 触发依赖它的 computed 重算（与 `stores/agents.ts` 里 `identities` 的写法一致）。
 */
const overrides = ref<ModelOverrideMap>(readStored());

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(overrides.value));
  } catch {
    // 配额满：覆盖只在本次会话内有效，不打断聊天
  }
}

/**
 * 读某个会话的模型覆盖。
 *
 * 返回 `undefined` 表示**没显式选过**，调用方应回落到全局偏好
 * （`settings.selectedModel`，作为新窗格的初始值）；返回 `""` 表示用户显式选了
 * 「默认模型」，调用方必须照用，不能再回落。
 */
export function readModelOverride(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  if (!key) return undefined;
  return Object.prototype.hasOwnProperty.call(overrides.value, key)
    ? overrides.value[key]
    : undefined;
}

/** 写某个会话的模型覆盖（空串有效，表示「使用网关默认模型」）。 */
export function writeModelOverride(sessionKey: string, model: string): void {
  const key = sessionKey.trim();
  if (!key) return;
  overrides.value = { ...overrides.value, [key]: model };
  persist();
}

/** 清掉某个会话的覆盖（当前无调用方，留给后续「恢复默认」入口）。 */
export function clearModelOverride(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key || !Object.prototype.hasOwnProperty.call(overrides.value, key)) return;
  const next = { ...overrides.value };
  delete next[key];
  overrides.value = next;
  persist();
}

/** 当前落盘的覆盖条数（单测 / 排查用）。 */
export function modelOverrideCount(): number {
  return Object.keys(overrides.value).length;
}
