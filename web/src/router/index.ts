import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import {
  captureUrlOverridesOnce,
  entryLandingPath,
  sanitizeInternalPath,
} from "@/utils/urlOverrides";

// 必须早于 createWebHistory()：先解析并清理地址栏里的 #token= / ?token=，
// 否则 token 会被路由的 redirect 参数裹挟，登录后又写回地址栏。
captureUrlOverridesOnce();

// 路由 base 必须走 import.meta.env.BASE_URL，让 gateway.controlUi.basePath 子路径部署生效：
// vite.config.ts 把它转成 VITE_BASE_PATH，构建期常量；运行时由 index.html 的内联启动脚本
// 同步到 window.__OPENCLAW_BASE_PATH__。此处只信任构建期常量即可满足前端路由刷新回退。
const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/views/LoginView.vue"),
    meta: { public: true },
  },
  // DEV-ONLY 调试路由：直接渲染 MarkdownView，验证 markdown-it + DOMPurify + hljs 链路。
  // `import.meta.env.DEV` 在生产构建里是字面量 false，整段会被 tree-shake 掉。
  ...(import.meta.env.DEV
    ? [
        {
          path: "/_md-test",
          name: "md-test",
          component: () => import("@/views/MdTestView.vue"),
          meta: { public: true },
        } as RouteRecordRaw,
      ]
    : []),
  {
    path: "/",
    component: () => import("@/layouts/MainLayout.vue"),
    // 落地页随入口意图变化：
    //   - 旧版 ui/ `?view=terminal` → 直接进全屏终端（不显示侧栏）
    //   - 带 #token= 的静默登录 → 进「对话」
    //   - 普通访问 → 进「概览」
    // 必须在 `/` 这一层决定 —— 等 router.beforeEach 拿到 to 时，`/` 已经被重定向成
    // 具体路径了，那时再想改就分不清「用户明确点了概览」还是「根路径默认去概览」。
    redirect: () => {
      if (typeof window !== "undefined") {
        const view = new URLSearchParams(window.location.search).get("view");
        if (view === "terminal") return "/terminal";
      }
      return entryLandingPath();
    },
    children: [
      // { path: "overview", name: "overview", component: () => import("@/views/OverviewView.vue"), meta: { title: "概览", icon: "Odometer" } },
      {
        path: "chat",
        name: "chat",
        component: () => import("@/views/ChatView.vue"),
        meta: { title: "对话", icon: "ChatDotRound" },
      },
      // { path: "sessions", name: "sessions", component: () => import("@/views/SessionsView.vue"), meta: { title: "会话", icon: "Files" } },
      // { path: "channels", name: "channels", component: () => import("@/views/ChannelsView.vue"), meta: { title: "通道", icon: "Connection" } },
      // { path: "agents", name: "agents", component: () => import("@/views/AgentsView.vue"), meta: { title: "智能体", icon: "UserFilled" } },
      // { path: "skills", name: "skills", component: () => import("@/views/SkillsView.vue"), meta: { title: "技能", icon: "MagicStick" } },
      // { path: "skills/workshop", name: "skill-workshop", component: () => import("@/views/SkillWorkshopView.vue"), meta: { title: "技能工坊", icon: "Reading", hidden: true } },
      // { path: "cron", name: "cron", component: () => import("@/views/CronView.vue"), meta: { title: "定时任务", icon: "Timer" } },
      // { path: "usage", name: "usage", component: () => import("@/views/UsageView.vue"), meta: { title: "用量", icon: "DataLine" } },
      // { path: "logs", name: "logs", component: () => import("@/views/LogsView.vue"), meta: { title: "日志", icon: "Document" } },
      // { path: "activity", name: "activity", component: () => import("@/views/ActivityView.vue"), meta: { title: "活动", icon: "Calendar" } },
      // { path: "workboard", name: "workboard", component: () => import("@/views/WorkboardView.vue"), meta: { title: "工作台", icon: "Grid" } },
      // { path: "instances", name: "instances", component: () => import("@/views/InstancesView.vue"), meta: { title: "实例", icon: "Monitor" } },
      // { path: "nodes", name: "nodes", component: () => import("@/views/NodesView.vue"), meta: { title: "节点", icon: "Connection" } },
      // { path: "tasks", name: "tasks", component: () => import("@/views/TasksView.vue"), meta: { title: "任务", icon: "List" } },
      // { path: "plugin", name: "plugin", component: () => import("@/views/PluginView.vue"), meta: { title: "插件", icon: "MagicStick" } },
      // { path: "dreams", name: "dreams", component: () => import("@/views/DreamsView.vue"), meta: { title: "梦境", icon: "Moon" } },
      // { path: "debug", name: "debug", component: () => import("@/views/DebugView.vue"), meta: { title: "调试", icon: "Tools" } },
      // { path: "worktrees", name: "worktrees", component: () => import("@/views/WorktreesView.vue"), meta: { title: "工作树", icon: "FolderOpened" } },
      // { path: "config", name: "config", component: () => import("@/views/ConfigView.vue"), meta: { title: "配置", icon: "Setting" } },
      // { path: "settings/general", name: "settings-general", component: () => import("@/views/ConfigView.vue"), props: { pageId: "config" }, meta: { hidden: true } },
      // { path: "settings/communications", name: "settings-communications", component: () => import("@/views/ConfigView.vue"), props: { pageId: "communications" }, meta: { hidden: true } },
      // { path: "settings/appearance", name: "settings-appearance", component: () => import("@/views/ConfigView.vue"), props: { pageId: "appearance" }, meta: { hidden: true } },
      // { path: "settings/automation", name: "settings-automation", component: () => import("@/views/ConfigView.vue"), props: { pageId: "automation" }, meta: { hidden: true } },
      // { path: "settings/mcp", name: "settings-mcp", component: () => import("@/views/ConfigView.vue"), props: { pageId: "mcp" }, meta: { hidden: true } },
      // { path: "settings/infrastructure", name: "settings-infrastructure", component: () => import("@/views/ConfigView.vue"), props: { pageId: "infrastructure" }, meta: { hidden: true } },
      // { path: "settings/ai-agents", name: "settings-ai-agents", component: () => import("@/views/ConfigView.vue"), props: { pageId: "ai-agents" }, meta: { hidden: true } },
    ],
  },
  // Terminal: full-screen (outside MainLayout), mirrors ui/ ?view=terminal.
  // { path: "/terminal", name: "terminal", component: () => import("@/views/TerminalView.vue"), meta: { title: "终端", icon: "Terminal", layout: "blank" } },
  { path: "/:pathMatch(.*)*", redirect: "/chat" },
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

/** 未连接时跳转到登录页。 */
router.beforeEach((to) => {
  if (to.meta.public) return true;
  // 已「就绪」（同 tab 已成功握手过）→ 直接进
  if (sessionStorage.getItem("openclaw.gateway.ready") === "1") return true;
  // 自动连接中（App.vue 的 autoConnect 正在握手）→ 留在目标页等握手完成，
  // 避免「刷新 / 新 tab / URL token 静默登录」流程被踢回登录页导致体验断裂。
  try {
    const phase = useGatewayStore().phase;
    if (phase === "connecting" || phase === "connected" || phase === "reconnecting") {
      return true;
    }
  } catch {
    // pinia 还没初始化（路由首次解析早于 pinia）—— 保守地走到登录页
  }
  // 兜底：即使 URL 清理被绕过，也不把敏感参数带进 redirect 参数
  return { name: "login", query: { redirect: sanitizeInternalPath(to.fullPath) } };
});

export const navRoutes =
  routes
    .find((r) => r.path === "/")
    ?.children?.map((child) => ({
      name: String(child.name ?? ""),
      path: `/${String(child.path ?? "")}`,
      title: String((child.meta as { title?: string } | undefined)?.title ?? child.name ?? ""),
      icon: String((child.meta as { icon?: string } | undefined)?.icon ?? "Menu"),
    })) ?? [];
