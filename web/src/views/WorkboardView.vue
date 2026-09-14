<script setup lang="ts">
/**
 * Workboard 视图 — 完整 CRUD 版本，对齐 ui/src/pages/workboard/ 的功能面。
 * RPC: workboard.cards.list / create / update / move / archive / comment
 *      workboard.dispatch (TODO 后续接入)
 *
 * 字段约定（从 ui/ view.test fixture 推）：
 *   card: { id, title, status, priority, labels[], position, notes?, agentId?,
 *           sessionKey?, createdAt, updatedAt, comments?[] }
 *   column status: todo / in_progress / review / done / blocked
 *   priority:      high / normal / low
 */
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";

type Priority = "high" | "normal" | "low";
type CardStatus = "todo" | "in_progress" | "review" | "done" | "blocked";

interface CardComment {
  id: string;
  body: string;
  author?: string;
  createdAt?: number;
}

interface WorkboardCard {
  id: string;
  title: string;
  status: CardStatus | string;
  priority: Priority | string;
  labels?: string[];
  position?: number;
  notes?: string;
  agentId?: string | null;
  sessionKey?: string | null;
  createdAt?: number;
  updatedAt?: number;
  comments?: CardComment[];
  archived?: boolean;
}

interface ColumnDef {
  id: CardStatus | string;
  title: string;
}

const STATUS_COLUMNS: ColumnDef[] = [
  { id: "todo", title: "待办" },
  { id: "in_progress", title: "进行中" },
  { id: "review", title: "评审" },
  { id: "done", title: "已完成" },
  { id: "blocked", title: "阻塞" },
];

const PRIORITY_OPTIONS: Array<{ value: Priority; label: string }> = [
  { value: "high", label: "高" },
  { value: "normal", label: "中" },
  { value: "low", label: "低" },
];

const gateway = useGatewayStore();
const loading = ref(false);
const cards = ref<WorkboardCard[]>([]);
const columns = ref<ColumnDef[]>(STATUS_COLUMNS);

const grouped = computed(() => {
  const cols = columns.value;
  const map = new Map<string, WorkboardCard[]>();
  for (const c of cols) map.set(c.id, []);
  const fallback = "__unscoped__";
  if (!map.has(fallback)) map.set(fallback, []);
  for (const c of cards.value) {
    const key = c.status && map.has(c.status) ? c.status : fallback;
    map.get(key)!.push(c);
  }
  return cols.map((c) => ({ ...c, items: map.get(c.id) ?? [] }));
});

const showCreate = ref(false);
const showEdit = ref(false);
const showComment = ref(false);
const editingCard = ref<WorkboardCard | null>(null);
const commentingCard = ref<WorkboardCard | null>(null);

const createForm = ref({
  title: "",
  notes: "",
  status: "todo" as CardStatus,
  priority: "normal" as Priority,
  labels: "",
});
const editForm = ref({
  id: "",
  title: "",
  notes: "",
  status: "todo" as CardStatus,
  priority: "normal" as Priority,
  labels: "",
});
const commentBody = ref("");

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await gateway.request<{ cards?: WorkboardCard[]; columns?: ColumnDef[] }>(
      "workboard.cards.list",
      { includeArchived: false },
    );
    cards.value = res?.cards ?? [];
    if (res?.columns?.length) columns.value = res.columns;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  createForm.value = { title: "", notes: "", status: "todo", priority: "normal", labels: "" };
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  const title = createForm.value.title.trim();
  if (!title) {
    ElMessage.warning("请输入卡片标题");
    return;
  }
  try {
    await gateway.request("workboard.cards.create", {
      title,
      notes: createForm.value.notes || undefined,
      status: createForm.value.status,
      priority: createForm.value.priority,
      labels: parseLabels(createForm.value.labels),
      position: Date.now(),
    });
    ElMessage.success("已创建");
    showCreate.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

function openEdit(card: WorkboardCard): void {
  editingCard.value = card;
  editForm.value = {
    id: card.id,
    title: card.title ?? "",
    notes: card.notes ?? "",
    status: (card.status as CardStatus) ?? "todo",
    priority: (card.priority as Priority) ?? "normal",
    labels: (card.labels ?? []).join(", "),
  };
  showEdit.value = true;
}

async function submitEdit(): Promise<void> {
  if (!editForm.value.id) return;
  try {
    await gateway.request("workboard.cards.update", {
      id: editForm.value.id,
      patch: {
        title: editForm.value.title,
        notes: editForm.value.notes,
        status: editForm.value.status,
        priority: editForm.value.priority,
        labels: parseLabels(editForm.value.labels),
      },
    });
    ElMessage.success("已保存");
    showEdit.value = false;
    editingCard.value = null;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function moveCard(card: WorkboardCard, newStatus: CardStatus): Promise<void> {
  try {
    await gateway.request("workboard.cards.move", {
      id: card.id,
      status: newStatus,
      position: Date.now(),
    });
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function archiveCard(card: WorkboardCard): Promise<void> {
  try {
    await ElMessageBox.confirm(`归档卡片「${card.title}」？`, "确认", { type: "warning" });
    await gateway.request("workboard.cards.archive", { id: card.id, archived: true });
    ElMessage.success("已归档");
    await load();
  } catch (e) {
    if ((e as { type?: string }).type !== "cancel") {
      ElMessage.error((e as Error).message);
    }
  }
}

function openComment(card: WorkboardCard): void {
  commentingCard.value = card;
  commentBody.value = "";
  showComment.value = true;
}

async function submitComment(): Promise<void> {
  if (!commentingCard.value) return;
  const body = commentBody.value.trim();
  if (!body) {
    ElMessage.warning("请输入评论内容");
    return;
  }
  try {
    await gateway.request("workboard.cards.comment", { id: commentingCard.value.id, body });
    ElMessage.success("已评论");
    showComment.value = false;
    commentingCard.value = null;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

function parseLabels(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmt(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : "-";
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">工作台</h2>
      <div class="header-actions">
        <el-button @click="load" :loading="loading">刷新</el-button>
        <el-button type="primary" @click="openCreate">新建卡片</el-button>
      </div>
    </header>

    <div v-if="!loading && cards.length === 0" class="empty-hint">
      暂无卡片。点击「新建卡片」开始。
    </div>

    <div v-else class="board">
      <section v-for="col in grouped" :key="col.id" class="column">
        <header class="column-header">
          <span class="column-title">{{ col.title }}</span>
          <el-tag size="small">{{ col.items.length }}</el-tag>
        </header>
        <ul class="card-list">
          <li v-for="card in col.items" :key="card.id" class="wb-card card">
            <div class="card-head">
              <span class="card-title">{{ card.title || card.id }}</span>
              <el-tag v-if="card.priority" size="small" :type="card.priority === 'high' ? 'danger' : card.priority === 'low' ? 'info' : 'warning'">
                {{ card.priority }}
              </el-tag>
            </div>
            <div v-if="card.notes" class="card-body">{{ card.notes }}</div>
            <div v-if="card.labels?.length" class="card-labels">
              <el-tag v-for="l in card.labels" :key="l" size="small" type="info" effect="plain">{{ l }}</el-tag>
            </div>
            <div class="card-meta">
              <span v-if="card.agentId" class="card-agent">{{ card.agentId }}</span>
              <span class="card-time">{{ fmt(card.updatedAt ?? card.createdAt) }}</span>
              <span v-if="card.comments?.length" class="card-comments">💬 {{ card.comments.length }}</span>
            </div>
            <div class="card-actions">
              <el-select
                :model-value="card.status"
                size="small"
                class="move-select"
                @change="(v: string) => moveCard(card, v as CardStatus)"
              >
                <el-option v-for="c in columns" :key="c.id" :label="c.title" :value="c.id" />
              </el-select>
              <el-button size="small" @click.stop="openComment(card)">评论</el-button>
              <el-button size="small" @click.stop="openEdit(card)">编辑</el-button>
              <el-button size="small" type="danger" plain @click.stop="archiveCard(card)">归档</el-button>
            </div>
          </li>
          <li v-if="col.items.length === 0" class="empty-column">暂无</li>
        </ul>
      </section>
    </div>

    <!-- 新建对话框 -->
    <el-dialog v-model="showCreate" title="新建卡片" width="520">
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" placeholder="卡片标题" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.notes" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
        <div class="form-row">
          <el-form-item label="列">
            <el-select v-model="createForm.status" class="full">
              <el-option v-for="c in columns" :key="c.id" :label="c.title" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="优先级">
            <el-select v-model="createForm.priority" class="full">
              <el-option v-for="p in PRIORITY_OPTIONS" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="createForm.labels" placeholder="例如：ui, proof, e2e" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑对话框 -->
    <el-dialog v-model="showEdit" title="编辑卡片" width="520">
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.notes" type="textarea" :rows="3" />
        </el-form-item>
        <div class="form-row">
          <el-form-item label="列">
            <el-select v-model="editForm.status" class="full">
              <el-option v-for="c in columns" :key="c.id" :label="c.title" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="优先级">
            <el-select v-model="editForm.priority" class="full">
              <el-option v-for="p in PRIORITY_OPTIONS" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="editForm.labels" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 评论对话框 -->
    <el-dialog v-model="showComment" :title="`评论：${commentingCard?.title ?? ''}`" width="520">
      <div v-if="commentingCard?.comments?.length" class="comment-list">
        <div v-for="c in commentingCard.comments" :key="c.id" class="comment-item">
          <div class="comment-meta">
            <span>{{ c.author ?? "anonymous" }}</span>
            <span class="dim">{{ fmt(c.createdAt) }}</span>
          </div>
          <div class="comment-body">{{ c.body }}</div>
        </div>
      </div>
      <div v-else class="empty-hint">暂无评论</div>
      <el-input v-model="commentBody" type="textarea" :rows="3" placeholder="添加评论…" />
      <template #footer>
        <el-button @click="showComment = false">取消</el-button>
        <el-button type="primary" @click="submitComment">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  align-items: flex-start;
}
.column {
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 12px;
  min-height: 200px;
}
.column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 0 4px;
}
.column-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
}
.card-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  padding: 10px 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
}
.card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
  word-break: break-word;
}
.card-body {
  font-size: 12px;
  color: var(--wb-text-secondary);
  margin-bottom: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.card-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.card-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--wb-text-tertiary);
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.move-select {
  width: 100px;
}
.empty-column {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  padding: 12px;
  text-align: center;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius);
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.full {
  width: 100%;
}
.comment-list {
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.comment-item {
  background: var(--wb-bg-inset);
  padding: 8px 10px;
  border-radius: var(--wb-radius);
}
.comment-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--wb-text-tertiary);
  margin-bottom: 4px;
}
.comment-body {
  font-size: 12px;
  color: var(--wb-text-primary);
  white-space: pre-wrap;
}
.dim {
  color: var(--wb-text-tertiary);
}
</style>