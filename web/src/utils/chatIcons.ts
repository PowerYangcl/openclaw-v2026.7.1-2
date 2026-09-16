/**
 * 直接复用旧版 Lit UI 的图标资源（`ui/src/components/icons.ts`）。
 *
 * 为什么不换 Element Plus 图标：产品要求「拆分视图的图标直接复用 ui 层已有的图标资源」——
 * `panelRightOpen` / `panelBottomOpen` / `folder` 这类自定义 Lucide 风格图标在
 * Element Plus 里没有一一对应的图形，换掉会改变观感。这里把旧版的**原始 path 数据**
 * 原样搬过来（`<svg>` 外壳与 stroke 由 `ChatIcon.vue` 统一提供，与旧版 `.btn svg`
 * 的 `fill:none / stroke:currentColor / stroke-width:1.5px` 一致）。
 *
 * value 是 `<svg>` 的**内部**标记（path / circle / rect / line），不含 svg 标签本身。
 */
export const CHAT_ICONS = {
  /** 附件菜单：选择文件（旧版 `icons.folder`）。 */
  folder: `
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      />
  `,
  /** 附件菜单：拍照（旧版 `icons.camera`，产品要求 CSS 隐藏，代码保留）。 */
  camera: `
      <path
        d="M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z"
      />
      <circle cx="12" cy="13" r="3" />
  `,
  /** 附件菜单：照片（旧版 `icons.image`，产品要求 CSS 隐藏，代码保留）。 */
  image: `
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  `,
  /** 非图片附件的卡片图标（旧版 `icons.paperclip`）。 */
  paperclip: `
      <path
        d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
      />
  `,
  /** 拆分视图入口 / 向右拆分（旧版 `icons.panelRightOpen`）。 */
  panelRightOpen: `
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" stroke-linecap="round" />
      <path d="M10 10l-3 2 3 2" stroke-linecap="round" stroke-linejoin="round" />
  `,
  /** 向下拆分（旧版 `icons.panelBottomOpen`）。 */
  panelBottomOpen: `
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 15h18" stroke-linecap="round" />
      <path d="m10 8 2 3 2-3" stroke-linecap="round" stroke-linejoin="round" />
  `,
  /** 关闭窗格（旧版 `icons.x`）。 */
  x: `
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
  `,
} as const;

export type ChatIconName = keyof typeof CHAT_ICONS;
