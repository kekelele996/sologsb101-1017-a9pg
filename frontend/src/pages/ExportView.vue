<script setup lang="ts">
/**
 * /export 出炉检验登记与 JSON 结构版本导入导出
 * 判定不合格时生成返工提示并保留原始工序记录；消费 Inspect 及全部模型。
 * 复用组件：<StatBadge>、<EmptyPanel>、<StageTag>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { DB_NAME, DB_SCHEMA_VERSION, db, exportSnapshot, importSnapshot, resetDatabase } from '@/utils/db'
import { exportScheduleCsvFile, exportSnapshotJson, parseSnapshot } from '@/utils/export'
import { useIdbTable } from '@/hooks/useIdbTable'
import { INSPECT_RESULT_OPTIONS, type Inspect, type InspectDraft, type InspectResult } from '@/types/inspect'
import { today } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const annealStore = useAnnealStore()
const furnaceStore = useFurnaceStore()

const { rows, loading, create, update, remove } = useIdbTable<Inspect>(db.inspects, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const resultFilter = ref<InspectResult | 'all'>('all')
const formRef = ref<FormInstance>()

const form = reactive<InspectDraft>({
  pieceId: '',
  result: '合格',
  defectNote: '',
  inspector: '',
  date: today(),
})

const rules = computed<FormRules<InspectDraft>>(() => ({
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  result: [{ required: true, message: '请选择检验结果', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检验人', trigger: 'blur' }],
  date: [{ required: true, message: '请选择检验日期', trigger: 'change' }],
  defectNote:
    form.result === '合格' ? [] : [{ required: true, message: '判定不合格时必须填写缺陷说明', trigger: 'blur' }],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

/** 按窑炉对账结果（设备侧派生） */
const reconcileRows = computed(() => furnaceStore.reconcile.rows)
const reconcileOrphans = computed(() => furnaceStore.reconcile.orphans)
const suspendedPieces = computed(() => pieceStore.suspendedPieces)
const outboxRows = computed(() => pieceStore.outbox)

const pieceNameOf = (pieceId: string): string => pieceLabel.value[pieceId] ?? `（作品 ${pieceId}）`

/** 窑号不符明细文本 */
function mismatchText(issues: Array<{ seq: number; stepFurnaceCode: string }>): string {
  return issues.map((issue) => `第${issue.seq}道写「${issue.stepFurnaceCode}」`).join('；')
}

async function handleReconcile(): Promise<void> {
  const count = await pieceStore.runReconcile()
  ElMessage[count > 0 ? 'warning' : 'success'](pieceStore.lastMessage)
}

async function handleRetryOutbox(): Promise<void> {
  const remaining = await pieceStore.retryOutbox()
  await pieceStore.loadOutbox()
  ElMessage[remaining === 0 ? 'success' : 'warning'](pieceStore.lastMessage)
}

async function handleDiscardOutbox(): Promise<void> {
  try {
    await ElMessageBox.confirm('清空后这些待落账工序将不再重试，确认清空技师侧重试队列？', '确认清空', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await pieceStore.discardOutbox()
  ElMessage.success('已清空待重试队列')
}

const filtered = computed<Inspect[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (pieceLabel.value[row.pieceId] ?? '').toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.defectNote.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date))
})

const stats = computed(() => {
  const total = rows.value.length
  const pass = rows.value.filter((row) => row.result === '合格').length
  const defect = total - pass
  return {
    total,
    pass,
    defect,
    passPct: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    inProgress: pieceStore.pieces.filter((row) => row.state === '设计中' || row.state === '制作中').length,
    occupancyRate: annealStore.occupancyRate,
  }
})

onMounted(() => {
  void pieceStore.loadAll()
  void annealStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    result: row.result,
    defectNote: row.defectNote,
    inspector: row.inspector,
    date: row.date,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form }, 'inspect')
      ElMessage.success(
        form.result === '合格'
          ? '检验已登记：合格'
          : `检验已登记：${form.result}，已生成返工提示（原始工序记录保留不变）`,
      )
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('检验记录已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Inspect): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的检验记录（${row.result}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('检验记录已删除')
}

async function handleExportJson(): Promise<void> {
  const snapshot = await exportSnapshot()
  const filename = exportSnapshotJson(snapshot)
  ElMessage.success(`已导出整库存档 ${filename}`)
}

function handleExportCsv(): void {
  const filename = exportScheduleCsvFile(
    furnaceStore.furnaces,
    furnaceStore.batches,
    pieceStore.pieces,
    pieceStore.steps,
    annealStore.anneals,
    rows.value,
  )
  ElMessage.success(`已导出窑务排产汇总 ${filename}`)
}

async function handleImport(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (raw === undefined) return
  const text = await raw.text()
  const result = parseSnapshot(text)
  if (!result.ok || result.snapshot === null) {
    ElMessage.error(result.message)
    return
  }
  await importSnapshot(result.snapshot)
  await Promise.all([pieceStore.loadAll(), annealStore.loadAll(), furnaceStore.loadAll()])
  ElMessage.success(`导入成功：${result.message}`)
}

function handleReset(): void {
  ElMessageBox.confirm(
    '全部窑炉、料液批次、作品、工序、退火与检验记录都会被清空，并重新灌入演示数据。',
    '确认重置本地数据？',
    { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetDatabase()
      await Promise.all([pieceStore.loadAll(), annealStore.loadAll(), furnaceStore.loadAll()])
      ElMessage.success('已重置为演示数据')
    })
    .catch(() => undefined)
}

const defectRows = computed<Inspect[]>(() => rows.value.filter((row) => row.result !== '合格'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="不合格" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="合格率" :value="`${stats.passPct}%`" :percent="stats.passPct" tone="success" icon="PieChart" />
      <StatBadge label="在制件数" :value="stats.inProgress" suffix="件" tone="warning" icon="TrendCharts" />
      <StatBadge
        label="窑位占用率"
        :value="`${stats.occupancyRate}%`"
        :percent="stats.occupancyRate"
        tone="primary"
        icon="PieChart"
      />
      <StatBadge
        label="数据结构版本"
        :value="`v${DB_SCHEMA_VERSION}`"
        :suffix="`· ${DB_NAME}`"
        tone="info"
        icon="Histogram"
        hint="IndexedDB 库名与结构版本；v3 为工序挂窑炉、作品对账挂起、新增技师侧重试队列"
      />
    </div>

    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">按窑炉对账（设备台账 ↔ 工序台账）</span>
          <el-button type="warning" plain @click="handleReconcile">
            <el-icon><Refresh /></el-icon>
            <span>重新对账</span>
          </el-button>
        </div>
      </template>

      <el-alert
        v-if="suspendedPieces.length === 0 && reconcileOrphans.length === 0"
        type="success"
        show-icon
        :closable="false"
        title="全部作品工序上写的窑号与设备台账一致，没有挂起件。"
        description="每道工序都快照了当时窑号与温度上限；窑炉改号 / 删除后可点「重新对账」，对不上会自动挂起，对上即解除。"
      />

      <div v-else class="reconcile-wrap">
        <el-alert
          v-if="suspendedPieces.length > 0"
          type="error"
          show-icon
          :closable="false"
          class="mb-14"
          :title="`${suspendedPieces.length} 件作品窑号对不上已挂起（不可新增 / 推进工序、不可进入退火排位）`"
        >
          <template #default>
            <div class="suspend-detail">
              <div v-for="row in suspendedPieces" :key="row.id">
                <b>{{ row.name }}</b>：{{ row.suspendReason }}
              </div>
            </div>
          </template>
        </el-alert>

        <el-table :data="reconcileRows" row-key="furnaceId" size="small" stripe>
          <el-table-column prop="furnaceCode" label="窑号" width="110" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <StageTag :furnace-state="row.state" size="small" />
            </template>
          </el-table-column>
          <el-table-column prop="maxTempC" label="上限(℃)" width="100" align="right" />
          <el-table-column prop="stepCount" label="挂窑工序" width="100" align="right" />
          <el-table-column label="超上限" width="90" align="right">
            <template #default="{ row }">
              <span :class="{ 'cell-warn': row.overLimitCount > 0 }">{{ row.overLimitCount }}</span>
            </template>
          </el-table-column>
          <el-table-column label="窑号不符" width="90" align="right">
            <template #default="{ row }">
              <span :class="{ 'cell-warn': row.mismatchCount > 0 }">{{ row.mismatchCount }}</span>
            </template>
          </el-table-column>
          <el-table-column label="挂起作品" width="90" align="right">
            <template #default="{ row }">
              <span :class="{ 'cell-warn': row.suspendedPieceCount > 0 }">{{ row.suspendedPieceCount }}</span>
            </template>
          </el-table-column>
          <el-table-column label="不符明细" min-width="260">
            <template #default="{ row }">
              <span v-if="row.issues.length === 0" class="cell-sub">一致</span>
              <span v-else class="cell-warn">{{ mismatchText(row.issues) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          v-if="reconcileOrphans.length > 0"
          type="error"
          show-icon
          :closable="false"
          class="mt-14"
          :title="`${reconcileOrphans.length} 道工序所挂窑炉在设备台账已不存在（窑炉缺失）`"
        >
          <template #default>
            <div class="suspend-detail">
              <div v-for="issue in reconcileOrphans" :key="issue.stepId">
                {{ pieceNameOf(issue.pieceId) }} · 第 {{ issue.seq }} 道「{{ issue.name }}」仍写着窑号
                「{{ issue.stepFurnaceCode || '（空）' }}」。
              </div>
            </div>
          </template>
        </el-alert>
      </div>
    </el-card>

    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">技师侧落账重试队列（与设备台账互不连坐）</span>
          <el-space>
            <el-button type="primary" plain :disabled="outboxRows.length === 0" @click="handleRetryOutbox">
              <el-icon><RefreshRight /></el-icon>
              <span>按本侧重试（{{ outboxRows.length }}）</span>
            </el-button>
            <el-button type="danger" plain :disabled="outboxRows.length === 0" @click="handleDiscardOutbox">
              清空队列
            </el-button>
          </el-space>
        </div>
      </template>

      <el-alert
        v-if="outboxRows.length === 0"
        type="success"
        show-icon
        :closable="false"
        title="没有待重试的落账：技师台账写入正常。"
        description="技师落账失败时只进这张本侧重试表，设备侧窑炉 / 料液台账不受影响；重试成功后自动出队。"
      />
      <el-table v-else :data="outboxRows" row-key="id" size="small" stripe>
        <el-table-column prop="stepId" label="工序 id" min-width="200" />
        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.op === 'put' ? 'warning' : 'danger'">
              {{ row.op === 'put' ? '写入' : '删除' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="attempts" label="尝试次数" width="90" align="right" />
        <el-table-column prop="updatedAt" label="最近尝试" width="200" />
        <el-table-column prop="lastError" label="失败原因" min-width="260" />
      </el-table>
    </el-card>

    <el-alert
      v-if="defectRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${defectRows.length} 条检验记录判定不合格，已生成返工提示`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows" :key="row.id">
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：
            {{ row.defectNote }} —— 原始工序记录保留，可在工序页重新推进状态后再次入窑退火。
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">出炉检验登记与结构版本</span>
          <el-space wrap>
            <el-button @click="handleExportJson">
              <el-icon><Download /></el-icon>
              <span>导出 JSON 存档</span>
            </el-button>
            <el-button @click="handleExportCsv">
              <el-icon><Download /></el-icon>
              <span>导出 CSV 汇总</span>
            </el-button>
            <el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="handleImport">
              <el-button>
                <el-icon><Upload /></el-icon>
                <span>导入 JSON 存档</span>
              </el-button>
            </el-upload>
            <el-button type="danger" plain @click="handleReset">重置演示数据</el-button>
            <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记检验</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'result', label: '检验结果', options: INSPECT_RESULT_OPTIONS as unknown as string[] }]"
        :values="{ result: resultFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 条`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'result') resultFilter = value as InspectResult | 'all' }"
        @reset="
          () => {
            keyword = ''
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有出炉检验记录"
        description="作品退火出炉后登记检验结果；判定为裂纹 / 气泡 / 变形时会生成返工提示，同时保留原始工序记录用于追溯。"
        action-text="登记第一条检验"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !pieceStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <StageTag
                :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检验日期" width="120" />
        <el-table-column label="检验结果" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.result === '合格' ? 'success' : row.result === '裂纹' ? 'danger' : row.result === '气泡' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明 / 返工提示" min-width="300">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="110" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select v-model="form.pieceId" filterable style="width: 100%">
            <el-option
              v-for="item in pieceStore.pieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · ${item.state}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="检验结果" prop="result">
              <el-select v-model="form.result" style="width: 100%">
                <el-option v-for="item in INSPECT_RESULT_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验人" prop="inspector">
              <el-input v-model="form.inspector" placeholder="如：吴岚" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="缺陷说明" prop="defectNote">
          <el-input
            v-model="form.defectNote"
            type="textarea"
            :rows="2"
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度，并给出返工建议'"
          />
        </el-form-item>
        <el-alert
          v-if="form.result !== '合格'"
          type="warning"
          show-icon
          :closable="false"
          :title="`判定为「${form.result}」将生成返工提示`"
          description="原始吹制工序记录会完整保留，返工后可在工序页重新推进状态并再次入窑退火。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="检验合格后作品状态会自动回写为「已检验」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.defect-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.reconcile-wrap {
  display: flex;
  flex-direction: column;
}

.suspend-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
