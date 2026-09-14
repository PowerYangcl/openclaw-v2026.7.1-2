<script setup lang="ts">
/**
 * SchemaForm — 递归 JSON Schema → Element Plus 表单渲染器。
 *
 * 支持：
 *   - string（带 enum → select，minLength ≥ 50 或 format=multiline → textarea）
 *   - number / integer → input-number
 *   - boolean → switch
 *   - array of primitives → 动态列表（add/remove）
 *   - 复杂类型（anyOf / array-of-objects）→ JSON textarea 兜底
 *   - 敏感字段（path 匹配 /password|token|secret|api.?key/i 或 hint.sensitive=true）→ 隐藏 + 「显示」按钮
 *
 * 不支持（后续 PR 增强）：
 *   - anyOf / oneOf / allOf → JSON 兜底
 *   - array of objects → JSON 兜底
 *   - x-tags / sections / search → 直接拍平
 *
 * 引用：src/shared/config-ui-hints-types.ts（ConfigUiHint / ConfigUiHints）
 */
import { computed, ref } from "vue";

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  nullable?: boolean;
};

interface ConfigUiHint {
  label?: string;
  help?: string;
  placeholder?: string;
  sensitive?: boolean;
  advanced?: boolean;
}
type ConfigUiHints = Record<string, ConfigUiHint>;

const props = withDefaults(
  defineProps<{
    schema: JsonSchema | null;
    modelValue: Record<string, unknown> | null;
    uiHints?: ConfigUiHints;
    disabled?: boolean;
    pathPrefix?: string;
  }>(),
  { uiHints: () => ({}), disabled: false, pathPrefix: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, unknown>];
}>();

const advancedOpen = ref(false);

const SENSITIVE_PATTERN = /(password|secret|api.?key|token$|serviceaccount)/i;
const WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordfile",
];

function joinPath(parent: string, key: string | number): string {
  if (!parent) return String(key);
  return `${parent}.${key}`;
}

function isSensitivePath(path: string, hint?: ConfigUiHint): boolean {
  if (hint?.sensitive) return true;
  const lower = path.toLowerCase();
  if (WHITELIST_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  return SENSITIVE_PATTERN.test(path);
}

function getHint(path: string): ConfigUiHint | undefined {
  const explicit = props.uiHints[path];
  if (explicit) return explicit;
  for (const [key, hint] of Object.entries(props.uiHints)) {
    if (!key.includes("*")) continue;
    const kp = key.split(".");
    const pp = path.split(".");
    if (kp.length !== pp.length) continue;
    let match = true;
    for (let i = 0; i < pp.length; i++) {
      if (kp[i] !== "*" && kp[i] !== pp[i]) {
        match = false;
        break;
      }
    }
    if (match) return hint;
  }
  return undefined;
}

function humanize(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

function schemaType(schema: JsonSchema | null | undefined): string | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null") ?? schema.type[0];
  return schema.type;
}

function getCurrentValue(): Record<string, unknown> {
  return props.modelValue ?? {};
}

function patchValue(path: Array<string | number>, value: unknown): void {
  const root: Record<string, unknown> = JSON.parse(JSON.stringify(getCurrentValue()));
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const next = (cursor as Record<string, unknown>)[k];
    if (next == null || typeof next !== "object") {
      (cursor as Record<string, unknown>)[k] = {};
    }
    cursor = (cursor as Record<string, unknown>)[k] as Record<string, unknown> | unknown[];
  }
  (cursor as Record<string, unknown>)[path[path.length - 1]] = value;
  emit("update:modelValue", root);
}

function isEnumString(s: JsonSchema | undefined): boolean {
  return s != null && schemaType(s) === "string" && Array.isArray(s.enum);
}
function isMultilineString(s: JsonSchema | undefined): boolean {
  if (!s || schemaType(s) !== "string") return false;
  if (s.format === "multiline" || s.format === "text") return true;
  if (s.minLength != null && s.minLength >= 50) return true;
  return false;
}
function isPrimitiveArray(s: JsonSchema | undefined): boolean {
  if (!s || schemaType(s) !== "array") return false;
  const item = Array.isArray(s.items) ? s.items[0] : s.items;
  if (!item) return true;
  const t = schemaType(item);
  return t === "string" || t === "number" || t === "integer" || t === "boolean";
}
function fieldKind(s: JsonSchema | undefined): "enum" | "boolean" | "number" | "string" | "multiline" | "primitiveArray" | "fallback" {
  if (!s) return "fallback";
  if (isEnumString(s)) return "enum";
  const t = schemaType(s);
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "string") return isMultilineString(s) ? "multiline" : "string";
  if (isPrimitiveArray(s)) return "primitiveArray";
  return "fallback";
}

function primitiveItemDefault(t: string): unknown {
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  return "";
}

const visibleFields = computed(() => {
  if (!props.schema || !props.schema.properties) return [];
  const required = new Set(props.schema.required ?? []);
  const all = Object.entries(props.schema.properties).map(([key, sub]) => {
    const path = joinPath(props.pathPrefix, key);
    const hint = getHint(path);
    return {
      key,
      schema: sub,
      hint,
      advanced: !!hint?.advanced,
      required: required.has(key),
      path,
      kind: fieldKind(sub),
    };
  });
  return all.filter((f) => advancedOpen.value || !f.advanced);
});

const showAdvancedToggle = computed(() =>
  props.pathPrefix === "" &&
  Object.values(props.uiHints).some((h) => h?.advanced),
);

// 单字段渲染所需的状态（在每个 <FieldEditor> 范围内）
const sensitiveRevealed = ref<Set<string>>(new Set());

function reveal(path: string): void {
  sensitiveRevealed.value = new Set([...sensitiveRevealed.value, path]);
}

function onFieldChange(key: string, v: unknown): void {
  patchValue([key], v);
}
</script>

<template>
  <div v-if="schema && schema.properties" class="schema-form">
    <div v-if="showAdvancedToggle" class="advanced-toggle">
      <el-checkbox v-model="advancedOpen">显示高级选项</el-checkbox>
    </div>
    <el-form label-position="top" :disabled="disabled">
      <template v-for="f in visibleFields" :key="f.key">
        <el-form-item
          v-if="f.kind === 'enum' && f.schema.enum"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <el-select
            :model-value="getCurrentValue()[f.key]"
            :disabled="disabled"
            :placeholder="f.hint?.placeholder"
            @update:model-value="(v: unknown) => onFieldChange(f.key, v)"
          >
            <el-option v-for="opt in f.schema.enum" :key="String(opt)" :label="String(opt)" :value="opt" />
          </el-select>
        </el-form-item>

        <el-form-item
          v-else-if="f.kind === 'boolean'"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <el-switch
            :model-value="!!getCurrentValue()[f.key]"
            :disabled="disabled"
            @update:model-value="(v: boolean | string | number) => onFieldChange(f.key, v === true)"
          />
        </el-form-item>

        <el-form-item
          v-else-if="f.kind === 'number'"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <el-input-number
            :model-value="typeof getCurrentValue()[f.key] === 'number' ? (getCurrentValue()[f.key] as number) : undefined"
            :disabled="disabled"
            :min="f.schema.minimum"
            :max="f.schema.maximum"
            :step="schemaType(f.schema) === 'integer' ? 1 : 0.1"
            :placeholder="f.hint?.placeholder"
            @update:model-value="(v: number | undefined) => onFieldChange(f.key, v ?? 0)"
          />
        </el-form-item>

        <el-form-item
          v-else-if="f.kind === 'multiline'"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <el-input
            :model-value="(getCurrentValue()[f.key] as string) ?? ''"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 8 }"
            :disabled="disabled"
            :placeholder="f.hint?.placeholder"
            @update:model-value="(v: string) => onFieldChange(f.key, v)"
          />
        </el-form-item>

        <el-form-item
          v-else-if="f.kind === 'string'"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <div v-if="isSensitivePath(f.path, f.hint) && !sensitiveRevealed.has(f.path) && getCurrentValue()[f.key]" class="sensitive-row">
            <el-input model-value="••••••••" readonly :disabled="disabled" />
            <el-button size="small" @click="reveal(f.path)">显示</el-button>
          </div>
          <el-input
            v-else
            :model-value="(getCurrentValue()[f.key] as string) ?? ''"
            :disabled="disabled"
            :placeholder="f.hint?.placeholder"
            :maxlength="f.schema.maxLength"
            :show-word-limit="f.schema.maxLength != null"
            @update:model-value="(v: string) => onFieldChange(f.key, v)"
          />
        </el-form-item>

        <el-form-item
          v-else-if="f.kind === 'primitiveArray'"
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <div class="array-list">
            <div
              v-for="(item, idx) in ((getCurrentValue()[f.key] as unknown[]) ?? [])"
              :key="idx"
              class="array-row"
            >
              <el-input
                v-if="schemaType(Array.isArray(f.schema.items) ? f.schema.items[0] : f.schema.items) === 'string'"
                :model-value="(item as string) ?? ''"
                :disabled="disabled"
                :placeholder="f.hint?.placeholder"
                @update:model-value="(v: string) => {
                  const arr = ((getCurrentValue()[f.key] as unknown[]) ?? []).slice();
                  arr[idx] = v;
                  onFieldChange(f.key, arr);
                }"
              />
              <el-input-number
                v-else-if="['number', 'integer'].includes(schemaType(Array.isArray(f.schema.items) ? f.schema.items[0] : f.schema.items) ?? '')"
                :model-value="(item as number) ?? 0"
                :disabled="disabled"
                :step="schemaType(Array.isArray(f.schema.items) ? f.schema.items[0] : f.schema.items) === 'integer' ? 1 : 0.1"
                @update:model-value="(v: number | undefined) => {
                  const arr = ((getCurrentValue()[f.key] as unknown[]) ?? []).slice();
                  arr[idx] = v ?? 0;
                  onFieldChange(f.key, arr);
                }"
              />
              <el-switch
                v-else-if="schemaType(Array.isArray(f.schema.items) ? f.schema.items[0] : f.schema.items) === 'boolean'"
                :model-value="!!item"
                :disabled="disabled"
                @update:model-value="(v: boolean | string | number) => {
                  const arr = ((getCurrentValue()[f.key] as unknown[]) ?? []).slice();
                  arr[idx] = v === true;
                  onFieldChange(f.key, arr);
                }"
              />
              <el-button size="small" type="danger" plain :disabled="disabled" @click="() => {
                const arr = ((getCurrentValue()[f.key] as unknown[]) ?? []).slice();
                arr.splice(idx, 1);
                onFieldChange(f.key, arr);
              }">删</el-button>
            </div>
            <el-button
              size="small"
              :disabled="disabled"
              @click="() => {
                const itemT = schemaType(Array.isArray(f.schema.items) ? f.schema.items[0] : f.schema.items) ?? 'string';
                const arr = ((getCurrentValue()[f.key] as unknown[]) ?? []).slice();
                arr.push(primitiveItemDefault(itemT));
                onFieldChange(f.key, arr);
              }"
            >+ 添加</el-button>
          </div>
        </el-form-item>

        <el-form-item
          v-else
          :label="(f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '')"
        >
          <template v-if="f.hint?.help" #label>
            <div class="form-label">
              <span>{{ (f.hint?.label || f.schema.title || humanize(f.key)) + (f.required ? ' *' : '') }}</span>
              <small class="help-text">{{ f.hint.help }}</small>
            </div>
          </template>
          <el-input
            :model-value="getCurrentValue()[f.key] == null ? '' : JSON.stringify(getCurrentValue()[f.key], null, 2)"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 6 }"
            :disabled="disabled"
            placeholder="复杂类型（anyOf/array-of-objects/object），请使用 JSON"
            @update:model-value="(v: string) => {
              if (!v.trim()) { onFieldChange(f.key, undefined); return; }
              try { onFieldChange(f.key, JSON.parse(v)); }
              catch { onFieldChange(f.key, v); }
            }"
          />
        </el-form-item>
      </template>
      <div v-if="visibleFields.length === 0" class="empty-hint">
        此分组无可见字段（可能在「高级选项」里）
      </div>
    </el-form>
  </div>
  <div v-else class="empty-hint">无 schema 可渲染</div>
</template>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.advanced-toggle {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.form-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.help-text {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  font-weight: 400;
}
.sensitive-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.array-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.array-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 16px;
  text-align: center;
}
</style>