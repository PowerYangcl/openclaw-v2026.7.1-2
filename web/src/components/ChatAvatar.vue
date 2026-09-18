<script setup lang="ts">
/**
 * 消息头像。
 *
 * Vue 版 `ui/src/pages/chat/chat-avatar.ts` 的 `renderChatAvatar()`：
 *   user      ：用户图片头像 > **用户默认图标（Element Plus `Avatar` 图标）**
 *   assistant ：agent 图片头像 > agent 文本头像（emoji/字） > 助手默认图标
 *   tool/其他 ：角色默认图标
 *
 * ⚠️ user 与上游的一处**刻意差异**：上游会先取「用户文本头像 / 名称首字」再降级到图标，
 * 但本项目没有用户身份配置（`resolveLocalUserName(null)` 恒为兜底文案「你」），
 * 把「你」字当成头像既没有信息量又容易被误读成别人，所以 user 一律走 `Avatar` 图标。
 *
 * ## 站内头像（`/avatar/<agentId>`）怎么取
 *
 * 网关把「本地文件类型」的头像暴露成 **`/avatar/<agentId>`**（见
 * `src/gateway/control-ui.ts` 的 `handleControlUiAvatarRequest`），并且：
 *   - 需要鉴权：无 `?token=` 直接 401（`allowQueryToken: true`）；
 *   - **没有 CORS 响应头，OPTIONS 直接 404** —— 所以跨源 `fetch` 一定失败。
 *
 * 因此这里**不走 fetch/blob**，而是把路径解析成**网关源上的绝对地址**再交给
 * `<img src>` 直出（图片加载不受 CORS 限制）。旧实现直接在组件内 fetch 相对路径，
 * 且 `gatewayBasePath` 从来没有调用方传值 —— 跨源时请求打到前端的源上 → 404 破图，
 * 表现为「头像加载不出来」。
 *
 * 加载失败（破图 / 不可用）时按「文本头像 → 名称首字母 → 角色默认图标」降级。
 */
import { computed, ref, watch } from "vue";
import { Avatar } from "@element-plus/icons-vue";
import { useSettingsStore } from "@/stores/settings";
import {
  resolveAgentDisplayName,
  resolveAvatarImageSrc,
  resolveAssistantTextAvatar,
  resolveLocalUserAvatarText,
} from "@/utils/avatar";

const props = withDefaults(
  defineProps<{
    role: string;
    /** 展示名：assistant 用 agent 名称，user 用用户名称 */
    name?: string;
    /**
     * 头像原始值：图片路径 / 远端 URL / data URI / emoji / 文字。
     * 留空则按名称首字母 → 角色图标降级。
     */
    avatar?: string | null;
    /**
     * 直接给定的图片 URL（data: / blob: / 远端 https / 站内绝对路径）。
     * 设置后优先使用，跳过 `avatar` 判定。常用场景：父组件已经准备好了图片地址。
     */
    imageUrl?: string | null;
    /**
     * 网关鉴权 token。留空时回落到 `settings.token`。
     * 仅用于给**站内路径**补 `?token=`（远端 URL 绝不补，避免凭据外泄）。
     */
    token?: string;
    /** 头像边长（px），同时决定字号 */
    size?: number;
    /**
     * 归属 agent id。当 `avatar` 拿到的是服务器本地文件路径（网关没有转成
     * `/avatar/<id>` 的兜底情况）时，用它回退到网关的头像路由。
     */
    agentId?: string | null;
    /** 网关 `agent.identity.get` 的 `avatarStatus`（`local`/`remote`/`data`/`none`）。 */
    avatarStatus?: string | null;
  }>(),
  {
    name: "",
    avatar: "",
    imageUrl: null,
    token: "",
    size: 32,
    agentId: null,
    avatarStatus: null,
  },
);

const settings = useSettingsStore();

type AvatarKind = "user" | "assistant" | "tool" | "other";

/** 角色归一化，与上游 `normalizeRoleForGrouping` 保持一致。 */
const kind = computed<AvatarKind>(() => {
  const lower = (props.role || "").toLowerCase();
  if (lower === "user") return "user";
  if (lower === "assistant") return "assistant";
  if (lower === "tool" || lower === "toolresult" || lower === "tool_result" || lower === "function") {
    return "tool";
  }
  return "other";
});

/**
 * 文本头像/alt 用的名字。
 *
 * assistant 角色名走**统一解析链**：`name` 是网关泛化默认名 `Assistant` 时不算名字，
 * 改用 `agentId`（预发 8 个 agent 有 7 个没配身份，以前会一起显示成 `Assistant`）。
 */
const displayName = computed(() =>
  props.role?.toLowerCase() === "assistant"
    ? resolveAgentDisplayName({ agentId: props.agentId, name: props.name })
    : props.name?.trim() || "",
);

const rawAvatar = computed(() => (typeof props.avatar === "string" ? props.avatar.trim() : ""));

/** token：显式 prop 优先（便于测试/隔离），否则跟随全局设置。 */
const effectiveToken = computed(() => props.token || settings.token);

/** 图片加载失败后不再重试，直接降级（避免破图反复请求）。 */
const imageBroken = ref(false);

/** 图片 `<img src>`；空串表示「不是图片头像」，走文本/图标降级。 */
const resolvedImageUrl = computed<string>(() => {
  const explicit = typeof props.imageUrl === "string" ? props.imageUrl.trim() : "";
  if (explicit) {
    if (explicit.startsWith("blob:")) return explicit;
    if (/^data:/i.test(explicit) || /^https?:\/\//i.test(explicit)) return explicit;
    if (explicit.startsWith("/")) {
      return resolveAvatarImageSrc({
        raw: explicit,
        gatewayBaseUrl: settings.gatewayHttpBase,
        token: effectiveToken.value,
      });
    }
    return "";
  }
  return resolveAvatarImageSrc({
    raw: rawAvatar.value,
    gatewayBaseUrl: settings.gatewayHttpBase,
    token: effectiveToken.value,
    status: props.avatarStatus,
    agentId: props.agentId,
  });
});

const showImage = computed(() => Boolean(resolvedImageUrl.value) && !imageBroken.value);

/** 头像来源变了就允许重新尝试加载（例如切换 agent / 网关地址变化）。 */
watch(resolvedImageUrl, () => {
  imageBroken.value = false;
});

/** 文本头像候选：assistant 走 emoji/单字规则，user 走本地用户规则。 */
const textAvatar = computed(() => {
  if (kind.value === "user") return resolveLocalUserAvatarText({ avatar: rawAvatar.value });
  return resolveAssistantTextAvatar(rawAvatar.value);
});

/** 最后兜底：名称首字母（大写）。 */
const initial = computed(() => {
  const source = displayName.value.trim();
  if (!source) return "";
  return source.slice(0, 1).toUpperCase();
});

const fallbackText = computed(() => textAvatar.value ?? initial.value);

/**
 * 小尺寸（≤ 24px）自动走「subtle」样式：6px 圆角、去阴影、字号按 `size * 0.55`。
 *
 * 这是给侧栏 session-row（20px）和 chat-top header（24px）等**索引/标题场景**用的，
 * 圆角与同行的 fallback svg（`.session-row__icon-fallback`）一致。
 *
 * **注意**：subtle 不再统一去底色 —— 只有**图片头像**才透明底；
 * 文字/emoji 头像必须保留角色底色，详见下方 `.chat-avatar--subtle` 的样式注释。
 */
const subtle = computed(() => props.size <= 24);
const fontSize = computed(() => {
  if (subtle.value) return Math.max(10, Math.round(props.size * 0.55));
  return Math.max(11, Math.round(props.size * 0.4));
});
</script>

<template>
  <span
    class="chat-avatar"
    :class="[`chat-avatar--${kind}`, showImage ? 'chat-avatar--image' : '', subtle ? 'chat-avatar--subtle' : '']"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${fontSize}px` }"
    :aria-label="displayName || undefined"
    :title="displayName || undefined"
  >
    <img
      v-if="showImage"
      class="chat-avatar__img"
      :src="resolvedImageUrl"
      :alt="displayName"
      @error="imageBroken = true"
    />
    <!-- 用户头像：统一用 Element Plus 的 `Avatar` 图标（图片优先，见上）。
         图标走 currentColor（父级 `.chat-avatar` 的 `color: #fff`），
         底色与 assistant 同一套蓝（见 `.chat-avatar--assistant, .chat-avatar--user`）。 -->
    <el-icon v-else-if="kind === 'user'" class="chat-avatar__icon" aria-hidden="true">
      <Avatar />
    </el-icon>
    <span v-else-if="fallbackText" class="chat-avatar__text">{{ fallbackText }}</span>
    <svg v-else class="chat-avatar__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <template v-if="kind === 'assistant'">
        <path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2L8 14 2 9.2h7.6z" />
      </template>
      <template v-else-if="kind === 'tool'">
        <path
          d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53a7.76 7.76 0 0 0 .07-1 7.76 7.76 0 0 0-.07-.97l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.15 7.15 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65a7.15 7.15 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11a7.9 7.9 0 0 0 0 1.94l-2.11 1.69a.49.49 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.72 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.23 0 .44-.18.49-.42l.38-2.65a7.15 7.15 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64z"
        />
      </template>
      <template v-else>
        <circle cx="12" cy="12" r="10" />
      </template>
    </svg>
  </span>
</template>

<style scoped>
.chat-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: var(--wb-bg-hover);
  user-select: none;
}

.chat-avatar__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chat-avatar__text {
  font-weight: 700;
  letter-spacing: 0;
}

.chat-avatar__icon {
  width: 60%;
  height: 60%;
}

/* el-icon 里的 Element Plus 图标是 `<svg width="1em" height="1em">`，
   字号驱动尺寸会和手写 svg 的「60% 盒子」对不上；直接让内部 svg 撑满盒子，
   两种实现就同一视觉重量（`:deep` 因为 svg 属于子组件模板，不带本组件的 scope 属性）。 */
.chat-avatar__icon.el-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

/* 头像底色按角色区分，与目标页 chat-avatar 的配色语义对齐。
   ⚠️ user 与 assistant **共用同一套蓝底**（产品要求：用户头像背景色与 agent 一致），
   所以两者写在同一条规则里 —— 只留一处色值，改一边两边同步，不会再出现「改了蓝的
   漏了另一个」；白色 `Avatar` / 助手图标落在此蓝上对比度 ≈ 3.6:1，清晰可辨。 */
.chat-avatar--assistant,
.chat-avatar--user {
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.25);
}

.chat-avatar--tool {
  background: linear-gradient(135deg, #fbbf24, #d97706);
}

.chat-avatar--other {
  background: linear-gradient(135deg, #cbd5e1, #94a3b8);
}

/**
 * 小尺寸（≤24px）"subtle" 变体：用于侧栏 session-row（20px）、chat-top header（24px）。
 *
 * 核心区分：**图片头像** vs **文字/emoji 头像** —— 之前一律 `background: transparent`
 * 造成了「icon 没渲染出来」的观感：
 *   - study-abroad-consultant 的 avatar 是**图片**，透明底没问题，图片自己就是视觉；
 *   - cet4 的 avatar 是**文字**「英」，透明底后只剩一个灰色字符，用户会当成"缺 icon"。
 *
 * 现在的规则：
 *   - 圆角收成 6px（与同行 fallback svg `.session-row__icon-fallback` 一致），去掉阴影；
 *   - `.chat-avatar--image`（正在显示图片）→ 透明底；
 *   - 其余（文字 / emoji / svg 兜底）→ **保留角色底色**做成小 chip + 白字，
 *     这样在浅色列表里一眼能看出是个图标，且与上方 agent 行的配色一致。
 */
.chat-avatar--subtle {
  border-radius: 6px;
  box-shadow: none;
}

/* 图片：透明底，图片本身承担视觉 */
.chat-avatar--subtle.chat-avatar--image,
.chat-avatar--subtle.chat-avatar--image.chat-avatar--assistant,
.chat-avatar--subtle.chat-avatar--image.chat-avatar--user,
.chat-avatar--subtle.chat-avatar--image.chat-avatar--tool,
.chat-avatar--subtle.chat-avatar--image.chat-avatar--other {
  background: transparent;
  box-shadow: none;
}

/* 文字/emoji/图标：保留角色底色（靠后写覆盖上面的 transparent），白字 */
.chat-avatar--subtle.chat-avatar--assistant,
.chat-avatar--subtle.chat-avatar--user,
.chat-avatar--subtle.chat-avatar--tool,
.chat-avatar--subtle.chat-avatar--other {
  box-shadow: none;
  color: #fff;
  border-radius: 6px;
}

.chat-avatar--subtle .chat-avatar__text {
  font-weight: 600;
  letter-spacing: 0;
}

.chat-avatar--subtle .chat-avatar__icon {
  width: 62%;
  height: 62%;
}
</style>