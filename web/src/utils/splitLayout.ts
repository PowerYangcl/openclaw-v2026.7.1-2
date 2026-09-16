/**
 * 拆分视图布局模型（纯函数，无框架依赖）。
 *
 * 逐行移植自 `ui/src/pages/chat/split-layout.ts`：
 * 一个布局 = 若干**列**（columns，横向排列），每列 = 若干**窗格**（panes，纵向排列），
 * 外加两组权重（`columnWeights` 横向、`paneWeights` 纵向）与 `activePaneId`。
 *
 * ⚠️ 权重是**相对值**（同一层内加起来为 1），因此插入/关闭窗格后必须重新归一化，
 * 否则某一层会整体缩水（旧版 `normalizedWeights` 就是干这个的）。
 */

export type ChatSplitPane = { id: string; sessionKey: string };
type ChatSplitColumn = { id: string; panes: ChatSplitPane[]; paneWeights: number[] };
export type ChatSplitEdge = "left" | "right" | "up" | "down";
export type ChatSplitLayout = {
  columns: ChatSplitColumn[];
  columnWeights: number[];
  activePaneId: string;
};

/** 相邻两窗格/两列的最小占比（拖拽时把比例夹在这个区间内）。 */
const MIN_PAIR_SHARE = 0.15;

function cloneLayout(layout: ChatSplitLayout): ChatSplitLayout {
  return {
    columns: layout.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => ({ ...pane })),
      paneWeights: [...column.paneWeights],
    })),
    columnWeights: [...layout.columnWeights],
    activePaneId: layout.activePaneId,
  };
}

function equalWeights(length: number): number[] {
  return Array.from({ length }, () => 1 / length);
}

function normalizedWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? weights.map((weight) => weight / total) : equalWeights(weights.length);
}

function numericSuffix(id: string, prefix: string): number {
  const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
  return match ? Number(match[1]) : 0;
}

function nextColumnId(layout: ChatSplitLayout): string {
  const max = layout.columns.reduce(
    (current, column) => Math.max(current, numericSuffix(column.id, "c")),
    0,
  );
  return `c${max + 1}`;
}

export function nextPaneId(layout: ChatSplitLayout): string {
  const max = panesOf(layout).reduce(
    (current, pane) => Math.max(current, numericSuffix(pane.id, "p")),
    0,
  );
  return `p${max + 1}`;
}

export function createSinglePaneLayout(sessionKey: string): ChatSplitLayout {
  return {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
}

/** 「打开拆分视图」= 在单窗格布局右侧插入一个同会话的窗格。 */
export function createSplitLayout(sessionKey: string): ChatSplitLayout {
  return insertPane(createSinglePaneLayout(sessionKey), "p1", sessionKey, "right");
}

export function findPane(
  layout: ChatSplitLayout,
  paneId: string,
): { column: ChatSplitColumn; columnIndex: number; pane: ChatSplitPane; paneIndex: number } | null {
  for (let columnIndex = 0; columnIndex < layout.columns.length; columnIndex += 1) {
    const column = layout.columns[columnIndex];
    const paneIndex = column.panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex >= 0) {
      return {
        column: {
          ...column,
          panes: column.panes.map((pane) => ({ ...pane })),
          paneWeights: [...column.paneWeights],
        },
        columnIndex,
        pane: { ...column.panes[paneIndex] },
        paneIndex,
      };
    }
  }
  return null;
}

export function panesOf(layout: ChatSplitLayout): ChatSplitPane[] {
  return layout.columns.flatMap((column) => column.panes.map((pane) => ({ ...pane })));
}

/**
 * 在 `targetPaneId` 的指定方向插入一个新窗格。
 *
 * 左右 → 新起一列；上下 → 插进同一列。插入后**把被拆那一侧的权重一分为二**，
 * 保证新窗格占一半、视觉上「均匀裂开」（旧版行为）。
 */
export function insertPane(
  layout: ChatSplitLayout,
  targetPaneId: string,
  sessionKey: string,
  edge: ChatSplitEdge,
): ChatSplitLayout {
  const location = findPane(layout, targetPaneId);
  const next = cloneLayout(layout);
  if (!location) {
    return next;
  }
  const newPaneId = nextPaneId(layout);
  if (edge === "left" || edge === "right") {
    const sourceWeight = next.columnWeights[location.columnIndex];
    const insertIndex = location.columnIndex + (edge === "right" ? 1 : 0);
    next.columns.splice(insertIndex, 0, {
      id: nextColumnId(layout),
      panes: [{ id: newPaneId, sessionKey }],
      paneWeights: [1],
    });
    next.columnWeights.splice(location.columnIndex, 1, sourceWeight / 2, sourceWeight / 2);
  } else {
    const column = next.columns[location.columnIndex];
    const sourceWeight = column.paneWeights[location.paneIndex];
    const insertIndex = location.paneIndex + (edge === "down" ? 1 : 0);
    column.panes.splice(insertIndex, 0, { id: newPaneId, sessionKey });
    column.paneWeights.splice(location.paneIndex, 1, sourceWeight / 2, sourceWeight / 2);
  }
  next.activePaneId = newPaneId;
  return next;
}

/**
 * 关闭窗格。**只剩一个窗格时返回 `undefined`**（调用方据此退回单窗格渲染）。
 */
export function closePane(layout: ChatSplitLayout, paneId: string): ChatSplitLayout | undefined {
  const location = findPane(layout, paneId);
  if (!location) {
    return cloneLayout(layout);
  }
  const next = cloneLayout(layout);
  const column = next.columns[location.columnIndex];
  const activeWasClosed = next.activePaneId === paneId;
  let nextActivePaneId = next.activePaneId;
  if (activeWasClosed) {
    nextActivePaneId =
      column.panes[location.paneIndex - 1]?.id ??
      next.columns[location.columnIndex - 1]?.panes.at(-1)?.id ??
      next.columns.flatMap((entry) => entry.panes).find((pane) => pane.id !== paneId)?.id ??
      "";
  }
  column.panes.splice(location.paneIndex, 1);
  column.paneWeights.splice(location.paneIndex, 1);
  if (column.panes.length === 0) {
    next.columns.splice(location.columnIndex, 1);
    next.columnWeights.splice(location.columnIndex, 1);
  } else {
    column.paneWeights = normalizedWeights(column.paneWeights);
  }
  if (panesOf(next).length <= 1) {
    return undefined;
  }
  next.columnWeights = normalizedWeights(next.columnWeights);
  next.activePaneId = nextActivePaneId;
  return next;
}

export function setPaneSession(
  layout: ChatSplitLayout,
  paneId: string,
  sessionKey: string,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  const pane = next.columns.flatMap((column) => column.panes).find((entry) => entry.id === paneId);
  if (pane) {
    pane.sessionKey = sessionKey;
  }
  return next;
}

export function setActivePane(layout: ChatSplitLayout, paneId: string): ChatSplitLayout {
  const next = cloneLayout(layout);
  if (panesOf(layout).some((pane) => pane.id === paneId)) {
    next.activePaneId = paneId;
  }
  return next;
}

function resizePair(weights: number[], boundaryIndex: number, pairRatio: number): number[] {
  const next = [...weights];
  if (boundaryIndex < 0 || boundaryIndex + 1 >= weights.length) {
    return next;
  }
  const pairSum = weights[boundaryIndex] + weights[boundaryIndex + 1];
  const ratio = Math.max(MIN_PAIR_SHARE, Math.min(1 - MIN_PAIR_SHARE, pairRatio));
  next[boundaryIndex] = pairSum * ratio;
  next[boundaryIndex + 1] = pairSum * (1 - ratio);
  return next;
}

export function resizeColumns(
  layout: ChatSplitLayout,
  boundaryIndex: number,
  pairRatio: number,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  next.columnWeights = resizePair(next.columnWeights, boundaryIndex, pairRatio);
  return next;
}

export function resizePanes(
  layout: ChatSplitLayout,
  columnId: string,
  boundaryIndex: number,
  pairRatio: number,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.id === columnId);
  if (column) {
    column.paneWeights = resizePair(column.paneWeights, boundaryIndex, pairRatio);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 持久化读盘：脏数据一律静默降级（返回 undefined = 退回单窗格）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWeights(value: unknown, length: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((weight) => typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
  ) {
    return equalWeights(length);
  }
  return normalizedWeights(value);
}

function uniqueId(value: unknown, used: Set<string>, next: () => string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let generated = next();
  while (used.has(generated)) {
    generated = next();
  }
  used.add(generated);
  return generated;
}

/** 把任意来源（localStorage / 未来服务端）的布局归一化；非法则返回 undefined。 */
export function normalizeChatSplitLayout(value: unknown): ChatSplitLayout | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return undefined;
  }
  const rawColumns = value.columns.filter(isRecord);
  let paneSequence = rawColumns.reduce((max, rawColumn) => {
    if (!Array.isArray(rawColumn.panes)) {
      return max;
    }
    return rawColumn.panes.reduce((paneMax, rawPane) => {
      if (!isRecord(rawPane) || typeof rawPane.id !== "string") {
        return paneMax;
      }
      return Math.max(paneMax, numericSuffix(rawPane.id.trim(), "p"));
    }, max);
  }, 0);
  let columnSequence = rawColumns.reduce((max, rawColumn) => {
    return typeof rawColumn.id === "string"
      ? Math.max(max, numericSuffix(rawColumn.id.trim(), "c"))
      : max;
  }, 0);
  const usedPaneIds = new Set<string>();
  const usedColumnIds = new Set<string>();
  const columns: ChatSplitColumn[] = [];
  const sourceColumnIndexes: number[] = [];
  for (let columnIndex = 0; columnIndex < rawColumns.length; columnIndex += 1) {
    const rawColumn = rawColumns[columnIndex];
    if (!Array.isArray(rawColumn.panes)) {
      continue;
    }
    const panes: ChatSplitPane[] = [];
    const sourcePaneIndexes: number[] = [];
    for (let paneIndex = 0; paneIndex < rawColumn.panes.length; paneIndex += 1) {
      const rawPane = rawColumn.panes[paneIndex];
      if (!isRecord(rawPane) || typeof rawPane.sessionKey !== "string") {
        continue;
      }
      const sessionKey = rawPane.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      panes.push({
        id: uniqueId(rawPane.id, usedPaneIds, () => `p${++paneSequence}`),
        sessionKey,
      });
      sourcePaneIndexes.push(paneIndex);
    }
    if (panes.length === 0) {
      continue;
    }
    const rawPaneWeights = readWeights(rawColumn.paneWeights, rawColumn.panes.length);
    const paneWeights = normalizedWeights(sourcePaneIndexes.map((index) => rawPaneWeights[index]));
    columns.push({
      id: uniqueId(rawColumn.id, usedColumnIds, () => `c${++columnSequence}`),
      panes,
      paneWeights,
    });
    sourceColumnIndexes.push(columnIndex);
  }
  if (columns.length === 0) {
    return undefined;
  }
  const rawColumnWeights = readWeights(value.columnWeights, rawColumns.length);
  const columnWeights = normalizedWeights(
    sourceColumnIndexes.map((index) => rawColumnWeights[index]),
  );
  const allPanes = columns.flatMap((column) => column.panes);
  if (allPanes.length < 2) {
    return undefined;
  }
  const requestedActivePaneId =
    typeof value.activePaneId === "string" ? value.activePaneId.trim() : "";
  const activePaneId = allPanes.some((pane) => pane.id === requestedActivePaneId)
    ? requestedActivePaneId
    : allPanes[0].id;
  return { columns, columnWeights, activePaneId };
}

// ---------------------------------------------------------------------------
// 拖拽拆分落区（对齐旧版 split-drop-zone）
// ---------------------------------------------------------------------------

/** 窗格拖拽的 dataTransfer 类型：与「拖文件挂附件」区分开（后者走 `files`）。 */
export const PANE_DRAG_MIME = "application/x-openclaw-pane";

/** 离窗格边缘多少像素内算「想在这里拆分」。 */
export const PANE_DROP_EDGE_PX = 72;
